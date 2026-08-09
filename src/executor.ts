import { truncateToWidth } from "@earendil-works/pi-tui";
import * as path from "node:path";
import type {
	Task,
	Project,
	Reflection,
	ToolUsage,
	ReviewResult,
} from "./types";
import type { RalpiConfig } from "./types";
import type { ProgressTracker } from "./progress";
import type {
	ExtensionContext,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
	buildTaskPrompt,
	buildReviewPrompt,
	buildConflictResolutionPrompt,
	MAX_DIFF_BYTES,
} from "./prompts";
import { compileIgnorePatterns } from "./diff";
import { extractReflection } from "./reflection";
import {
	extractReview,
	saveReviewToFile as saveReviewJson,
	loadReview as loadReviewJson,
	verdictGlyph,
	verdictSummary,
} from "./review";
import {
	createWorktree,
	mergeWorktree,
	removeWorktree,
	reattemptMerge,
	abortMerge,
	hasMergeConflicts,
	completeMerge,
	worktreeHasPreservableWork,
	type WorktreeHandle,
	type MergeResult,
} from "./worktree";
import {
	runAgentSession,
	writeFileSafe,
	ensureDir,
	captureGitCommits,
	captureGitHead,
	canComputeRange,
	getCommitRangeDiff,
	hasUncommittedChanges,
	getGitStatusPorcelain,
	getGitDiff,
	resolveModelSpec,
	formatDuration,
} from "./utils";
import { updateTaskInFile } from "./parser";

/** Optional callback to post a progress message into the chat history. */
export type SendChatMessage = (
	content: string,
	/** Extra data passed to the message renderer for the expanded view. */
	meta?: {
		toolCalls?: ToolCallEntry[];
		/** Full review body for review messages — renderer shows it in the
		 *  expanded (Ctrl+O) view so long reviews aren't lost to truncation. */
		reviewText?: string;
		/** Saved file path when the review has been persisted to disk. */
		reviewPath?: string;
		/** Structured review result (when extractReview succeeded). */
		reviewResult?: ReviewResult;
	},
) => void;

export interface ToolCallEntry {
	name: string;
	label: string;
}

/** A merge conflict deferred from executeTask to batch-level resolution. */
export interface BatchConflict {
	task: Task;
	worktree: WorktreeHandle;
	mergeResult: MergeResult;
	/** The task's run result (reflection, commits, etc.) from executeTask. */
	result: {
		reflection?: Reflection;
		toolUsage?: ToolUsage;
		outputPreview?: string;
		commitMessages?: string[];
		commitSummary?: string;
		durationMs: number;
	};
}

// ─── Widget Expand/Collapse ───────────────────────────────────────────────

/** Max tool calls shown in a live widget before truncating. Widgets don't
 *  support message-style Ctrl+O expansion (that's only for chat-history
 *  messages rendered by registerMessageRenderer). */
const MAX_COLLAPSED = 3;

export const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
];

// ─── Model Round-Robin ─────────────────────────────────────────────────────

/**
 * Round-robin model assignment with slot reuse.
 *
 * With models [A, B, C] and 2 concurrent tasks, only A and B are used.
 * Model C is only touched when a third concurrent task starts.
 * Freed slots are reused before new slots are allocated.
 */
class ModelRoundRobin {
	private models: unknown[];
	private freeSlots: number[];
	private nextIndex = 0;
	private assignments = new Map<string, number>();

	constructor(models: unknown[]) {
		this.models = models;
		this.freeSlots = [];
	}

	get length(): number {
		return this.models.length;
	}

	/** All resolved models in the pool (for follow-up session failover). */
	get allModels(): unknown[] {
		return this.models;
	}

	assign(taskId: string): unknown {
		let index: number;
		if (this.freeSlots.length > 0) {
			// Reuse a freed model slot first
			index = this.freeSlots.shift()!;
		} else if (this.nextIndex < this.models.length) {
			// Allocate a new slot
			index = this.nextIndex++;
		} else {
			// All models in use — wrap around
			index = this.nextIndex % this.models.length;
			this.nextIndex++;
		}
		this.assignments.set(taskId, index);
		return this.models[index];
	}

	release(taskId: string): void {
		const index = this.assignments.get(taskId);
		if (index !== undefined) {
			this.freeSlots.push(index);
			this.freeSlots.sort((a, b) => a - b);
			this.assignments.delete(taskId);
		}
	}

	/**
	 * Advance a task to the next model slot without going through freed slots.
	 * Used for model failover — when the current model is down, skip to the
	 * next one instead of re-assigning the same freed index.
	 */
	advance(taskId: string): unknown {
		const currentIndex = this.assignments.get(taskId);
		if (currentIndex === undefined) {
			// No current assignment — fresh assign (fallback, shouldn't happen)
			return this.assign(taskId);
		}
		// If this index was freed (e.g. from an earlier release call that raced),
		// remove it from freeSlots so it's not handed out to another task.
		const freeIdx = this.freeSlots.indexOf(currentIndex);
		if (freeIdx !== -1) this.freeSlots.splice(freeIdx, 1);
		// Advance to the next index (circular)
		const nextIndex = (currentIndex + 1) % this.models.length;
		this.assignments.set(taskId, nextIndex);
		return this.models[nextIndex];
	}
}

/** Shared state for parallel-batch widget. Each running task writes its
 *  tool calls and spinner frame; the batch widget reads them in task-ID order. */
interface ParallelWidgetEntry {
	taskHeader: string;
	frameIndex: number;
	done: boolean;
	success: boolean;
	toolCalls: ToolCallEntry[];
}

type ParallelWidgetState = Map<string, ParallelWidgetEntry>;

// ─── Run Single Task ────────────────────────────────────────────────────────

/**
 * Execute a single task by spawning an async Pi agent session.
 * Non-blocking — the TUI remains responsive throughout.
 */
export async function runTask(
	task: Task,
	project: Project,
	config: RalpiConfig,
	depReflections: Reflection[],
	ctx: ExtensionContext,
	sendChatMessage?: SendChatMessage,
	projectDir: string = project.sourceDir,
	parallelState?: ParallelWidgetState,
	assignedModel?: unknown,
	batchRender?: () => void,
	/** Review feedback from a rejected review — injected when re-executing
	 *  a task in review-gated mode so the agent knows what to fix. */
	reviewFeedback?: ReviewResult,
): Promise<{
	success: boolean;
	reflection?: Reflection;
	error?: string;
	durationMs: number;
	toolUsage?: ToolUsage;
	outputPreview?: string;
	commitMessages?: string[];
	commitSummary?: string;
}> {
	const startMs = Date.now();

	// Build prompt
	const prompt = buildTaskPrompt(
		task,
		project,
		depReflections,
		config.prompts.projectContext,
		reviewFeedback,
	);

	const taskHeader = `${task.id} · ${task.title}`;

	// When running in parallel, all tasks share a single widget so ordering
	// is deterministic (sorted by task ID). In sequential mode each task gets
	// its own widget.
	const isParallel = !!parallelState;
	const widgetKey = `ralpi-task-${task.id}`;
	let frameIndex = 0;
	const toolCalls: ToolCallEntry[] = [];
	let widgetTui: { requestRender(): void } | null = null;

	if (isParallel) {
		parallelState!.set(task.id, {
			taskHeader,
			frameIndex: 0,
			done: false,
			success: false,
			toolCalls: [],
		});
	} else {
		// Build widget lines from current state. Live widgets can't expand/collapse
		// like chat messages, so we always truncate to MAX_COLLAPSED recent calls.
		const truncateWidth = 74; // Account for widget container padding
		const buildLines = (t: typeof ctx.ui.theme, width?: number): string[] => {
			const effectiveWidth = width
				? Math.min(width, truncateWidth)
				: truncateWidth;
			const frame = t.fg("accent", SPINNER_FRAMES[frameIndex]);
			const lines = [truncateToWidth(`${frame} ${taskHeader}`, effectiveWidth)];

			if (toolCalls.length > 0) {
				if (toolCalls.length <= MAX_COLLAPSED) {
					for (let i = 0; i < toolCalls.length; i++) {
						const entry = toolCalls[i];
						const isLast = i === toolCalls.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = t.fg("accent", `[${entry.name}]`);
						lines.push(
							truncateToWidth(`${branch}${tag} ${entry.label}`, effectiveWidth),
						);
					}
				} else {
					const shown = toolCalls.slice(-MAX_COLLAPSED);
					const remaining = toolCalls.length - shown.length;
					lines.push(
						truncateToWidth(
							t.fg("dim", `  ├── …${remaining} earlier`),
							effectiveWidth,
						),
					);
					for (let i = 0; i < shown.length; i++) {
						const entry = shown[i];
						const isLast = i === shown.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = t.fg("accent", `[${entry.name}]`);
						lines.push(
							truncateToWidth(`${branch}${tag} ${entry.label}`, effectiveWidth),
						);
					}
				}
			}
			return lines;
		};

		ctx.ui.setWidget(widgetKey, (tui, t) => {
			widgetTui = tui;
			return {
				render: (width?: number) => buildLines(t, width),
				invalidate: () => widgetTui?.requestRender(),
			};
		});
	}

	const requestRender = () => widgetTui?.requestRender();

	// Spinner animation (sequential only — parallel uses a single batch timer)
	let spinnerTimer: NodeJS.Timeout | undefined;
	if (!isParallel) {
		spinnerTimer = setInterval(() => {
			frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
			requestRender();
		}, 100);
	}

	// Use task-level timeout if set, otherwise fall back to config
	const timeoutMs = task.timeoutMs ?? config.execution.timeoutMs;

	// Run task asynchronously via Pi SDK — event loop stays responsive
	const output = await runAgentSession(
		prompt,
		projectDir,
		timeoutMs,
		(event) => {
			if (event.type === "tool_execution_start") {
				const label = formatToolArg(event.toolName, event.args);
				toolCalls.push({
					name: event.toolName,
					label,
				});
				if (isParallel) {
					const entry = parallelState!.get(task.id);
					if (entry) {
						entry.toolCalls.push({ name: event.toolName, label });
					}
					batchRender?.();
				} else {
					requestRender();
				}
			}
		},
		undefined, // no abort signal
		assignedModel ?? config.model,
		config.thinkingLevel,
		false, // noSkills — task sessions need skills
		(ctx.modelRegistry as any).runtime as ModelRuntime,
	);

	const durationMs = Date.now() - startMs;

	// Clear progress widget and status after task finishes
	if (spinnerTimer) clearInterval(spinnerTimer);
	if (isParallel) {
		const entry = parallelState!.get(task.id);
		if (entry) {
			entry.done = true;
			entry.success = output.success;
		}
		batchRender?.();
	} else {
		ctx.ui.setWidget(widgetKey, undefined);
	}

	if (!output.success) {
		// Failure reporting is handled by the caller (executeTask) to avoid
		// duplicate messages when model failover or retry cycling is active.
		return {
			success: false,
			error: output.error,
			durationMs,
		};
	}

	const agentText = output.text;
	const toolUsage = output.toolUsage;

	// Capture git commits made during this task
	const { commitMessages, commitSummary } = captureGitCommits(projectDir);

	// Build output preview (first 500 chars of agent text)
	const outputPreview =
		agentText.length > 500
			? agentText.slice(0, 500) + "\n... (truncated)"
			: agentText;

	// Extract reflection from agent output
	const reflection = extractReflection(agentText, task.id, task.title);

	// Post completion chat message — header only, renderer builds the expandable tree
	const dur = formatDuration(durationMs);
	sendChatMessage?.(`✓ ${taskHeader} (${dur})`, { toolCalls });

	return {
		success: true,
		reflection: reflection ?? undefined,
		durationMs,
		toolUsage,
		outputPreview,
		commitMessages,
		commitSummary,
	};
}

// ─── Execute Batch ───────────────────────────────────────────────────────────

/**
 * Execute a batch of tasks (sequentially or in parallel)
 */
// ─── Worktree Decision ──────────────────────────────────────────────────────

/** Determine if worktree isolation should be used based on config + mode. */
function shouldUseWorktrees(config: RalpiConfig, isParallel: boolean): boolean {
	switch (config.execution.worktrees) {
		case "always":
			return true;
		case "parallel":
			return isParallel;
		default:
			return false; // "never"
	}
}

export async function executeBatch(
	tasks: Task[],
	project: Project,
	config: RalpiConfig,
	progress: ProgressTracker,
	ctx: ExtensionContext,
	options?: { parallel?: boolean },
	sendChatMessage?: SendChatMessage,
	projectDir?: string,
): Promise<void> {
	// Defensive: ensure tasks is an iterable array
	if (!Array.isArray(tasks)) {
		throw new Error(
			`executeBatch received invalid tasks: expected array, got ${typeof tasks}`,
		);
	}

	// Set up model round-robin if configured.
	// Config entries are "<provider>/<model>" strings — resolve via modelRegistry.
	let roundRobin: ModelRoundRobin | null = null;
	if (config.execution.models.length > 0) {
		const resolvedModels: unknown[] = [];
		for (const entry of config.execution.models) {
			const slashIdx = entry.indexOf("/");
			if (slashIdx === -1) {
				ctx.ui.notify(
					`ralpi config: skipping model "${entry}" — expected <provider>/<model> format`,
					"warning",
				);
				continue;
			}
			const provider = entry.slice(0, slashIdx);
			const modelId = entry.slice(slashIdx + 1);
			const resolved = ctx.modelRegistry?.find(provider, modelId);
			if (resolved) {
				resolvedModels.push(resolved);
			} else {
				ctx.ui.notify(
					`ralpi config: model "${entry}" not found in registry — skipping`,
					"warning",
				);
			}
		}
		if (resolvedModels.length > 0) {
			roundRobin = new ModelRoundRobin(resolvedModels);
		}
	}

	// Check if we should run parallel.
	// Use the parallel path whenever the user selected parallel mode,
	// even for single-task batches produced by DAG dependency chains.
	// Only sequential mode should inherit the parent session model.
	const shouldParallel =
		options?.parallel && tasks.length > 0 && config.execution.maxParallel > 0;

	const useWorktree = shouldUseWorktrees(config, !!shouldParallel);

	const conflicts: BatchConflict[] = [];

	if (shouldParallel) {
		await executeBatchParallel(
			tasks,
			project,
			config,
			progress,
			ctx,
			sendChatMessage,
			projectDir,
			roundRobin,
			useWorktree,
			conflicts,
		);
	} else {
		// Execute sequentially (no round-robin — inherit parent model)
		for (const task of tasks) {
			try {
				await executeTask(
					task,
					project,
					config,
					progress,
					ctx,
					sendChatMessage,
					projectDir,
					undefined, // parallelState
					undefined, // assignedModel
					undefined, // roundRobin
					undefined, // batchRender
					useWorktree,
					conflicts,
				);
			} catch (error) {
				// Task failed — stop the batch. Dependent tasks are blocked by
				// the DAG layer (getBlockedTasks) so they won't appear in this batch.

				const errorMsg = error instanceof Error ? error.message : String(error);
				progress.markFailed(task.id, errorMsg);
				// Auto-update the PRD source file checkbox
				try {
					updateTaskInFile(project.sourcePath, task.id, "failed");
				} catch {
					// Best-effort
				}
				sendChatMessage?.(`✗ ${task.id} · ${task.title} — ${errorMsg}`);
				ctx.ui.notify(`Task ${task.id} failed: ${errorMsg}`, "error");
				break;
			}
		}
	}

	// ── Batch-level conflict resolution ──
	// After all tasks in the batch finish, resolve any deferred merge conflicts
	// by spawning resolution agent sessions. This doesn't block parallel slots.
	if (conflicts.length > 0) {
		ctx.ui.notify(
			`Resolving ${conflicts.length} merge conflict(s) from batch...`,
			"info",
		);
		const dir = projectDir ?? project.sourceDir;
		for (const c of conflicts) {
			await resolveConflictsSession(
				ctx,
				config,
				c.task,
				project,
				dir,
				c.worktree,
				config.model,
				roundRobin,
				progress,
				sendChatMessage,
			);
		}
	}
}

/**
 * Execute tasks in parallel using child processes
 */
async function executeBatchParallel(
	tasks: Task[],
	project: Project,
	config: RalpiConfig,
	progress: ProgressTracker,
	ctx: ExtensionContext,
	sendChatMessage?: SendChatMessage,
	projectDir?: string,
	roundRobin?: ModelRoundRobin | null,
	useWorktree?: boolean,
	conflicts?: BatchConflict[],
): Promise<void> {
	const maxParallel = config.execution.maxParallel;
	const sharedState: ParallelWidgetState = new Map();

	// Register a single batch widget that renders ALL parallel tasks in ID order.
	const widgetKey = `ralpi-parallel-${Date.now()}`;
	let widgetTui: { requestRender(): void } | null = null;

	const buildBatchLines = (
		t: typeof ctx.ui.theme,
		width?: number,
	): string[] => {
		const effectiveWidth = width || 74;
		const lines: string[] = [];
		const sortedIds = Array.from(sharedState.keys()).sort();

		for (const id of sortedIds) {
			const entry = sharedState.get(id)!;
			const frame = entry.done
				? entry.success
					? "✓"
					: "✗"
				: t.fg("accent", SPINNER_FRAMES[entry.frameIndex]);
			lines.push(
				truncateToWidth(`${frame} ${entry.taskHeader}`, effectiveWidth),
			);

			// Only show tool calls for in-progress tasks; completed/failed
			// tasks already have their tool-call tree in the chat history message.
			if (!entry.done && entry.toolCalls.length > 0) {
				if (entry.toolCalls.length <= MAX_COLLAPSED) {
					for (let i = 0; i < entry.toolCalls.length; i++) {
						const tc = entry.toolCalls[i];
						const isLast = i === entry.toolCalls.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = t.fg("accent", `[${tc.name}]`);
						lines.push(
							truncateToWidth(`${branch}${tag} ${tc.label}`, effectiveWidth),
						);
					}
				} else {
					const shown = entry.toolCalls.slice(-MAX_COLLAPSED);
					const remaining = entry.toolCalls.length - shown.length;
					lines.push(
						truncateToWidth(
							t.fg("dim", `  ├── …${remaining} earlier`),
							effectiveWidth,
						),
					);
					for (let i = 0; i < shown.length; i++) {
						const tc = shown[i];
						const isLast = i === shown.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = t.fg("accent", `[${tc.name}]`);
						lines.push(
							truncateToWidth(`${branch}${tag} ${tc.label}`, effectiveWidth),
						);
					}
				}
			}
		}
		return lines;
	};

	ctx.ui.setWidget(widgetKey, (tui, t) => {
		widgetTui = tui;
		return {
			render: (width?: number) => buildBatchLines(t, width),
			invalidate: () => widgetTui?.requestRender(),
		};
	});

	// Batch-render trigger: re-render on spinner ticks AND content changes.
	// Spinner animation requires requestRender() on every tick; without it,
	// spinner frames advance in memory but the display never updates.
	const requestBatchRender = () => widgetTui?.requestRender();

	const spinnerTimer = setInterval(() => {
		for (const entry of sharedState.values()) {
			if (!entry.done) {
				entry.frameIndex = (entry.frameIndex + 1) % SPINNER_FRAMES.length;
			}
		}
		requestBatchRender();
	}, 100);

	// Semaphore-based concurrency control:
	// Start up to maxParallel tasks immediately. When ANY task completes,
	// start the next pending task. This ensures slots fill as soon as they
	// open, instead of blocking on the oldest task (FIFO pattern).
	const pending = [...tasks];
	const running = new Set<Promise<void>>();

	/** Start the next pending task if a slot is available. */
	const kick = (): void => {
		while (running.size < maxParallel && pending.length > 0) {
			const task = pending.shift()!;
			const assignedModel = roundRobin?.assign(task.id);

			const p = executeTask(
				task,
				project,
				config,
				progress,
				ctx,
				sendChatMessage,
				projectDir,
				sharedState,
				assignedModel,
				roundRobin,
				requestBatchRender,
				useWorktree,
				conflicts,
			)
				.catch((error) => {
					// Safety net: one task failure should never crash the batch.
					// executeTask already marks failed and notifies, but catch as
					// a last resort so the error doesn't propagate and crash pi.
					roundRobin?.release(task.id);
					requestBatchRender();
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					progress.markFailed(task.id, errorMsg);
					// Auto-update the PRD source file checkbox
					try {
						updateTaskInFile(project.sourcePath, task.id, "failed");
					} catch {
						// Best-effort
					}
					sendChatMessage?.(`✗ ${task.id} · ${task.title} — ${errorMsg}`);
					ctx.ui.notify(`Task ${task.id} failed: ${errorMsg}`, "error");
				})
				.finally(() => {
					// Remove from running set and start next pending task
					running.delete(p);
					requestBatchRender();
					kick();
				});

			running.add(p);
		}
	};

	// Kick off initial batch of tasks (up to maxParallel)
	kick();

	// Wait for all tasks to complete (kick() adds new promises to `running`
	// when completed tasks free up slots, so we iterate until the set is empty).
	while (running.size > 0) {
		await Promise.race(running);
	}

	clearInterval(spinnerTimer);
	ctx.ui.setWidget(widgetKey, undefined);
}

// ─── Execute Single Task with Retry ──────────────────────────────────────────

async function executeTask(
	task: Task,
	project: Project,
	config: RalpiConfig,
	progress: ProgressTracker,
	ctx: ExtensionContext,
	sendChatMessage?: SendChatMessage,
	projectDir: string = project.sourceDir,
	parallelState?: ParallelWidgetState,
	assignedModel?: unknown,
	roundRobin?: ModelRoundRobin | null,
	batchRender?: () => void,
	useWorktree?: boolean,
	conflicts?: BatchConflict[],
): Promise<void> {
	// Model failover: when a provider/API is down, cycle through available models.
	// Pi's built-in retry (via SettingsManager) handles transient HTTP errors
	// with exponential backoff WITHIN a single prompt. Ralpi adds two layers on
	// top: (1) reattempt the SAME model up to `maxSameModelAttempts` times — a
	// sustained provider hiccup can exhaust pi's in-call retries mid-session,
	// and flapping to a different model on the first hard failure throws away
	// model-specific context; (2) once same-model retries are exhausted, cycle
	// to the next model in the round-robin pool.
	const maxModelAttempts = roundRobin ? roundRobin.length : 1;
	const maxSameModelAttempts = Math.max(
		1,
		config.execution.maxSameModelAttempts,
	);
	let modelAttempt = 0;
	let sameModelAttempt = 0;
	// Resolve implModel from config (used in sequential mode when no round-robin assignment).
	// In parallel mode, the round-robin assignedModel takes precedence.
	const implModel = resolveModelSpec(
		ctx.modelRegistry as { find(p: string, m: string): unknown } | undefined,
		config.execution.implModel,
		(msg) => ctx.ui.notify(msg, "warning"),
	);
	let currentModel: unknown = assignedModel ?? implModel ?? config.model;

	// ── Worktree isolation ──
	// When enabled, the task runs in a separate git worktree so parallel tasks
	// can't stomp each other's files, and review/commit see a clean single-task
	// diff. `worktreeDir` is used for agent cwd + git ops; `projectDir` stays as
	// the main repo dir for state saves (reflections, reviews, progress.json).
	const wt = useWorktree
		? createWorktree(
				projectDir,
				config.paths.stateDir,
				task.id,
				progress.getKey(),
				undefined,
				task.title,
			)
		: null;
	const worktreeDir = wt?.dir ?? projectDir;

	while (modelAttempt < maxModelAttempts) {
		// Model advancement happens in the cycling branch below (not here) so a
		// same-model retry `continue` doesn't re-advance and accidentally swap
		// models mid-retry. The first model uses `currentModel` set above.

		try {
			// Mark as in progress
			progress.markInProgress(task.id);
			// Auto-update the PRD source file checkbox
			try {
				updateTaskInFile(project.sourcePath, task.id, "in_progress");
			} catch {
				// Best-effort: don't fail the task over a checkbox update
			}

			// Get dependency reflections
			const depReflections = progress.getDependencyReflections(
				task.dependencies || [],
			);

			// Capture base HEAD before execution so the review-gated loop can diff
			// the complete task output (baseRef..HEAD) across execution + fix attempts.
			const baseRef = config.execution.autoReview
				? captureGitHead(worktreeDir)
				: undefined;

			// Load a prior review from disk when resuming an interrupted loop.
			// If the previous run's review rejected the task (verdict 'fail') and the
			// re-execution was lost to a crash/connection error, the findings would
			// otherwise be orphaned. Injecting them here gives the fresh run the
			// reviewer's feedback so it doesn't reintroduce the same blockers.
			let priorReview: ReviewResult | undefined;
			if (config.execution.autoReview) {
				const loaded = loadReviewJson(
					projectDir,
					config.paths.reviewsDir,
					task.id,
					progress.getKey(),
				);
				if (loaded && loaded.verdict === "fail") {
					priorReview = loaded;
					sendChatMessage?.(
						`↻ ${task.id} · ${task.title} — resuming with prior review feedback (${loaded.findings.length} findings)`,
					);
				}
			}

			// Run the task
			const result = await runTask(
				task,
				project,
				config,
				depReflections,
				ctx,
				sendChatMessage,
				worktreeDir,
				parallelState,
				currentModel,
				batchRender,
				priorReview,
			);

			if (result.success) {
				let finalCommitMessages = result.commitMessages ?? [];
				let finalCommitSummary = result.commitSummary ?? "";
				let finalReview: ReviewResult | undefined;
				let reviewRetries = 0;

				if (config.execution.autoReview) {
					// ── Review-gated loop: commit → review → re-execute on fail → merge on pass ──
					// The commit is mandated — when the task agent didn't self-commit, a
					// commit session handles it. Then the COMPLETE task diff (baseRef..HEAD)
					// is reviewed. On 'fail' the task is re-executed with the review feedback
					// injected (up to maxReviewRetries); after re-execution changes are
					// committed again and the full diff is re-reviewed with the SAME baseRef
					// so the reviewer sees the complete state, not just incremental fixes.
					// On pass the changes are already committed — the worktree merges next.
					const maxRetries = config.execution.maxReviewRetries;
					let attempt = 0;

					try {
						// ── Ensure committed (commit session fallback) ──
						// If the task agent didn't self-commit, a commit session handles it.
						if (hasUncommittedChanges(worktreeDir)) {
							const commitResult = await runCommitSession(
								ctx,
								config,
								task,
								worktreeDir,
								currentModel,
								roundRobin,
								sendChatMessage,
							);
							if (commitResult.success) {
								finalCommitMessages = [
									...finalCommitMessages,
									...commitResult.commitMessages,
								];
								finalCommitSummary = finalCommitSummary
									? `${finalCommitSummary}; ${commitResult.commitSummary}`
									: commitResult.commitSummary;
							}
						}

						// ── Review loop ──
						// baseRef was captured before runTask (above). Each review iteration
						// diffs the range baseRef..HEAD — the complete task output including
						// all fix attempts. On re-execution the same baseRef is reused.
						// A FAILED range computation (broken/stale base ref, git error) is
						// logged as a distinct warning and is never treated as a clean,
						// verified task — only a GENUINE "no changes" skips review.
						while (true) {
							if (!baseRef) {
								sendChatMessage?.(
									`~ review for ${task.id} · ${task.title} — diff could not be computed (could not capture base ref before execution)`,
								);
								break;
							}
							// Cheap guard mirroring canCompareToBase: if the captured base ref no
							// longer resolves (stale/broken worktree ref), warn explicitly and
							// never treat the task as review-verified.
							if (!canComputeRange(worktreeDir, baseRef)) {
								sendChatMessage?.(
									`~ review for ${task.id} · ${task.title} — diff could not be computed (base ref ${baseRef} no longer resolves)`,
								);
								break;
							}
							const rangeDiff = getCommitRangeDiff(worktreeDir, baseRef);
							if (rangeDiff.kind === "error") {
								sendChatMessage?.(
									`~ review for ${task.id} · ${task.title} — diff could not be computed (${rangeDiff.error})`,
								);
								break;
							}
							if (rangeDiff.kind === "no-changes") {
								sendChatMessage?.(
									`~ review for ${task.id} · ${task.title} — skipping review (no changes found between base and HEAD)`,
								);
								break;
							}
							const reviewInfo = rangeDiff;

							const reviewPrompt = buildReviewPrompt(
								task,
								project,
								reviewInfo.hash,
								reviewInfo.subject,
								reviewInfo.diff,
								{
									projectContext: config.prompts.projectContext,
									focus: config.prompts.reviewFocus,
									diffOptions: {
										extraPatterns: compileIgnorePatterns(
											config.review.extraIgnorePatterns,
										),
										ignorePaths: config.review.ignorePaths,
									},
								},
							);

							const reviewModel = resolveFollowUpModel(
								ctx,
								config.execution.reviewModel,
								currentModel,
							);
							const reviewModels = buildFailoverModels(reviewModel, roundRobin);

							const { result: reviewResult, toolCalls: reviewToolCalls } =
								await runFollowUpSession(
									ctx,
									config,
									reviewPrompt,
									worktreeDir,
									`review for ${task.id} · ${task.title}${
										attempt > 0 ? ` (attempt ${attempt + 1})` : ""
									}`,
									`review-${task.id}`,
									config.execution.reviewTimeoutMs,
									reviewModels,
								);

							if (!reviewResult.success) {
								sendChatMessage?.(
									`~ review for ${task.id} · ${task.title} — review session failed: ${reviewResult.error}`,
									{ toolCalls: reviewToolCalls },
								);
								break; // proceed with what we have (changes already committed)
							}

							const reviewText = reviewResult.text.trim();
							const review = extractReview(
								reviewText,
								task.id,
								reviewInfo.hash,
							);
							finalReview = review ?? undefined;

							// Persist structured review JSON when opted in.
							let reviewPath: string | undefined;
							if (review && config.execution.saveReviews) {
								reviewPath = saveReviewJson(
									projectDir,
									config.paths.reviewsDir,
									review,
									progress.getKey(),
								);
							}

							if (
								review &&
								(review.verdict === "pass" || review.verdict === "warn")
							) {
								// Review passed — all changes are committed; merge will follow.
								const label = `${verdictGlyph(review.verdict)} ${verdictSummary(review)}`;
								const savedHint = reviewPath ? ` · saved to ${reviewPath}` : "";
								sendChatMessage?.(
									`⚑ review for ${task.id} · ${task.title} — ${label}${savedHint}`,
									{
										toolCalls: reviewToolCalls,
										reviewText,
										reviewPath,
										reviewResult: review,
									},
								);
								break; // good to merge
							}

							// Review rejected (fail) or verdict not parsed.
							if (review) {
								sendChatMessage?.(
									`⚑ review for ${task.id} · ${task.title} — ${verdictGlyph(review.verdict)} ${verdictSummary(review)}`,
									{
										toolCalls: reviewToolCalls,
										reviewText,
										reviewPath,
										reviewResult: review,
									},
								);
							} else {
								const lines = reviewText.split("\n").filter((l) => l.trim());
								const tail = lines.slice(-3).join("\n");
								const savedHint = reviewPath ? ` · saved to ${reviewPath}` : "";
								sendChatMessage?.(
									`⚑ review for ${task.id} · ${task.title} — verdict not found${savedHint}\n${tail}`,
									{ toolCalls: reviewToolCalls, reviewText, reviewPath },
								);
							}

							if (attempt >= maxRetries) {
								// Retries exhausted — changes are already committed; proceed.
								if (config.execution.reviewBlockOnFail) {
									sendChatMessage?.(
										`✗ ${task.id} · ${task.title} — review rejected after ${maxRetries} retr${maxRetries === 1 ? "y" : "ies"} (reviewBlockOnFail)`,
									);
									progress.markFailed(
										task.id,
										`Review rejected after ${maxRetries} re-execution attempt(s)`,
									);
									try {
										updateTaskInFile(project.sourcePath, task.id, "failed");
									} catch {
										// Best-effort
									}
									roundRobin?.release(task.id);
									return;
								}
								sendChatMessage?.(
									`~ review for ${task.id} · ${task.title} — max retries (${maxRetries}) exhausted, proceeding with current state`,
								);
								break; // changes already committed — merge proceeds
							}

							attempt++;
							reviewRetries++;
							sendChatMessage?.(
								`↻ review for ${task.id} · ${task.title} — verdict ${review?.verdict ?? "unknown"}, re-executing with feedback (${attempt}/${maxRetries})...`,
							);

							// Re-execute the task with review feedback injected, cycling
							// through failover models on connection errors so a flaky
							// provider doesn't waste the review-fix attempt.
							const fixModels = buildFailoverModels(currentModel, roundRobin);
							let fixResult: Awaited<ReturnType<typeof runTask>> | undefined;
							for (
								let fixAttempt = 0;
								fixAttempt < fixModels.length;
								fixAttempt++
							) {
								const fixModel = fixModels[fixAttempt];
								let fixSameAttempt = 0;
								// Reattempt on the same model before cycling, matching the main
								// task loop's behavior.
								for (;;) {
									fixResult = await runTask(
										task,
										project,
										config,
										depReflections,
										ctx,
										sendChatMessage,
										worktreeDir,
										parallelState,
										fixModel,
										batchRender,
										review ?? undefined,
									);
									if (fixResult.success) break;
									if (fixSameAttempt < maxSameModelAttempts - 1) {
										fixSameAttempt++;
										sendChatMessage?.(
											`~ re-execution for ${task.id} · ${task.title} — reattempting model ${fixAttempt + 1}/${fixModels.length} (${fixSameAttempt + 1}/${maxSameModelAttempts}, previous: ${fixResult.error})`,
										);
										continue;
									}
									break; // same-model retries exhausted
								}
								if (fixResult.success) break;
								// Connection/error failover — try the next model.
								if (fixAttempt < fixModels.length - 1) {
									sendChatMessage?.(
										`~ re-execution for ${task.id} · ${task.title} — cycling to model ${fixAttempt + 2}/${fixModels.length} (previous: ${fixResult.error})`,
									);
								}
							}

							if (!fixResult || !fixResult.success) {
								sendChatMessage?.(
									`~ re-execution for ${task.id} · ${task.title} failed: ${fixResult?.error}`,
								);
								break; // proceed with what we have
							}

							// Merge commit messages from the fix attempt.
							finalCommitMessages = [
								...finalCommitMessages,
								...(fixResult.commitMessages ?? []),
							];
							finalCommitSummary = finalCommitSummary
								? `${finalCommitSummary}; ${fixResult.commitSummary ?? ""}`
								: (fixResult.commitSummary ?? "");

							// Ensure committed after re-execution (same commit fallback).
							if (hasUncommittedChanges(worktreeDir)) {
								const commitResult = await runCommitSession(
									ctx,
									config,
									task,
									worktreeDir,
									currentModel,
									roundRobin,
									sendChatMessage,
								);
								if (commitResult.success) {
									finalCommitMessages = [
										...finalCommitMessages,
										...commitResult.commitMessages,
									];
									finalCommitSummary = finalCommitSummary
										? `${finalCommitSummary}; ${commitResult.commitSummary}`
										: commitResult.commitSummary;
								}
							}
							// Loop back to review with the same baseRef — the reviewer sees the
							// complete diff (original work + fixes), not just incremental changes.
						}
					} catch (error) {
						sendChatMessage?.(
							`~ review/commit for ${task.id} · ${task.title} — error: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				} else if (config.execution.autoCommit) {
					// ── Commit only (no review) ──
					try {
						if (hasUncommittedChanges(worktreeDir)) {
							const commitResult = await runCommitSession(
								ctx,
								config,
								task,
								worktreeDir,
								currentModel,
								roundRobin,
								sendChatMessage,
							);
							if (commitResult.success) {
								finalCommitMessages = [
									...finalCommitMessages,
									...commitResult.commitMessages,
								];
								finalCommitSummary = finalCommitSummary
									? `${finalCommitSummary}; ${commitResult.commitSummary}`
									: commitResult.commitSummary;
							}
						}
					} catch (error) {
						sendChatMessage?.(
							`~ commit for ${task.id} · ${task.title} — auto-commit error: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}

				// Save reflection
				if (result.reflection) {
					saveReflectionToFile(
						projectDir,
						config,
						result.reflection,
						progress.getKey(),
					);
				}

				// ── Merge worktree back to main ──
				// After the commit lands on the worktree branch, merge it into the
				// main repo so downstream tasks see the changes. On conflict, the
				// conflict is deferred to batch-level resolution (the caller collects
				// conflicted worktrees and spawns resolution sessions after the batch).
				if (wt) {
					const mergeResult = mergeWorktree(projectDir, wt.branch);
					if (!mergeResult.success) {
						sendChatMessage?.(
							`⚠ ${task.id} · ${task.title} — merge conflict, deferring to batch resolution\n  ${mergeResult.message}`,
						);
						// Defer conflict resolution to the batch level.
						if (conflicts) {
							conflicts.push({
								task,
								worktree: wt,
								mergeResult,
								result: {
									reflection: result.reflection,
									toolUsage: result.toolUsage,
									outputPreview: result.outputPreview,
									commitMessages: finalCommitMessages,
									commitSummary: finalCommitSummary,
									durationMs: result.durationMs,
								},
							});
						} else {
							// No conflict collector — mark failed as fallback.
							progress.markFailed(task.id, mergeResult.message);
							try {
								updateTaskInFile(project.sourcePath, task.id, "failed");
							} catch {
								// Best-effort
							}
						}
						roundRobin?.release(task.id);
						return;
					}
					// Merge succeeded — clean up the worktree.
					removeWorktree(projectDir, wt);
					sendChatMessage?.(`✓ merged worktree for ${task.id} into main`);
				}

				// Mark completed with all metadata
				progress.markCompleted(
					task.id,
					result.durationMs,
					result.reflection,
					result.toolUsage,
					result.outputPreview,
					finalCommitMessages,
					finalCommitSummary,
					finalReview,
					reviewRetries,
				);
				// Auto-update the PRD source file checkbox
				try {
					updateTaskInFile(project.sourcePath, task.id, "completed");
				} catch {
					// Best-effort: don't fail the task over a checkbox update
				}
				roundRobin?.release(task.id);
				return;
			}

			// Agent session failed (provider error).
			// Pi's built-in in-call retry already exhausted for this attempt.
			// Reattempt on the SAME model a few more times before cycling — a
			// transient outage can outlast pi's per-prompt backoff window.
			sameModelAttempt++;
			if (sameModelAttempt < maxSameModelAttempts) {
				sendChatMessage?.(
					`~ ${task.id} · ${task.title} — reattempting model ${modelAttempt + 1}/${maxModelAttempts} (${sameModelAttempt + 1}/${maxSameModelAttempts}, previous: ${result.error})`,
				);
				continue; // same model, fresh session
			}

			// Same-model retries exhausted — cycle to the next model (if any).
			if (roundRobin && modelAttempt < maxModelAttempts - 1) {
				modelAttempt++;
				sameModelAttempt = 0;
				currentModel = roundRobin.advance(task.id);
				sendChatMessage?.(
					`~ ${task.id} · ${task.title} — cycling to model ${modelAttempt + 1}/${maxModelAttempts} (previous: ${result.error})`,
				);
				continue; // next model in the outer while loop
			}

			// All models exhausted.
			progress.markFailed(task.id, result.error || "Unknown error");
			try {
				updateTaskInFile(project.sourcePath, task.id, "failed");
			} catch {
				// Best-effort
			}
			sendChatMessage?.(`✗ ${task.id} · ${task.title} — ${result.error}`);
			ctx.ui.notify(
				`Task ${task.id} failed across ${maxModelAttempts} models: ${
					result.error || "Unknown error"
				}`,
				"error",
			);
			cleanupFailedWorktree(projectDir, wt, task, sendChatMessage);
			roundRobin?.release(task.id);
			return;
		} catch (error) {
			roundRobin?.release(task.id);
			batchRender?.();
			const errorMsg = error instanceof Error ? error.message : String(error);
			progress.markFailed(task.id, errorMsg);
			// Auto-update the PRD source file checkbox
			try {
				updateTaskInFile(project.sourcePath, task.id, "failed");
			} catch {
				// Best-effort
			}
			sendChatMessage?.(`✗ ${task.id} · ${task.title} — ${errorMsg}`);
			ctx.ui.notify(`Task ${task.id} failed: ${errorMsg}`, "error");
			cleanupFailedWorktree(projectDir, wt, task, sendChatMessage);
			return;
		}
	}

	// All models exhausted — release the slot
	roundRobin?.release(task.id);
	batchRender?.();
	progress.markFailed(task.id, "All configured models exhausted");
	sendChatMessage?.(
		`✗ ${task.id} · ${task.title} — all ${maxModelAttempts} models exhausted`,
	);
	ctx.ui.notify(
		`Task ${task.id} failed: all configured models exhausted`,
		"error",
	);
	cleanupFailedWorktree(projectDir, wt, task, sendChatMessage);
}

// ─── Save Reflection to File ────────────────────────────────────────────────

/**
 * Remove a task worktree after a failure UNLESS it still holds recoverable
 * work (commits ahead of main, or uncommitted changes).
 *
 * `removeWorktree` force-deletes the worktree's branch, which makes any
 * commits the agent made before failing/timing out unreachable — real code
 * loss. A preserved worktree is instead picked up on the next resume:
 * resume-finalize merges committed work into main, or the task re-runs in
 * place and the agent continues from where it stopped.
 */
function cleanupFailedWorktree(
	projectDir: string,
	wt: WorktreeHandle | null,
	task: Task,
	sendChatMessage?: SendChatMessage,
): void {
	if (!wt) return;
	if (worktreeHasPreservableWork(projectDir, wt)) {
		sendChatMessage?.(
			`~ ${task.id} · ${task.title} — task failed but worktree preserved (${wt.branch}); committed work will be merged on resume`,
		);
		return;
	}
	removeWorktree(projectDir, wt);
}

function saveReflectionToFile(
	sourceDir: string,
	config: RalpiConfig,
	reflection: Reflection,
	prdKey: string,
): void {
	const reflectionsDir = path.join(
		sourceDir,
		config.paths.reflectionsDir,
		prdKey,
	);
	ensureDir(reflectionsDir);
	const filePath = path.join(reflectionsDir, `${reflection.taskId}.json`);
	writeFileSafe(filePath, JSON.stringify(reflection, null, 2));
}

// ─── Follow-Up Sessions (Commit / Review) ─────────────────────────────────────

/**
 * Run a follow-up agent session (commit, review, etc.) with a live spinner
 * widget. Handles widget setup, spinner animation, session execution, and
 * cleanup. Cycles through `models` on connection failure so a flaky provider
 * doesn't kill the commit/review step. Returns the session result and
 * captured tool calls.
 */
async function runFollowUpSession(
	ctx: ExtensionContext,
	config: RalpiConfig,
	prompt: string,
	projectDir: string,
	header: string,
	widgetKeySuffix: string,
	timeoutMs: number,
	models: unknown[],
): Promise<{
	result: Awaited<ReturnType<typeof runAgentSession>>;
	toolCalls: ToolCallEntry[];
}> {
	const toolCalls: ToolCallEntry[] = [];
	let frameIndex = 0;
	let widgetTui: { requestRender(): void } | null = null;
	const widgetKey = `ralpi-${widgetKeySuffix}-${Date.now()}`;

	const truncateWidth = 74;

	const buildLines = (t: typeof ctx.ui.theme, width?: number): string[] => {
		const effectiveWidth = width
			? Math.min(width, truncateWidth)
			: truncateWidth;
		const frame = t.fg(
			"accent",
			SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length],
		);
		const lines = [truncateToWidth(`~ ${frame} ${header}`, effectiveWidth)];

		if (toolCalls.length > 0) {
			if (toolCalls.length <= MAX_COLLAPSED) {
				for (let i = 0; i < toolCalls.length; i++) {
					const entry = toolCalls[i];
					const isLast = i === toolCalls.length - 1;
					const branch = isLast ? "  └── " : "  ├── ";
					const tag = t.fg("accent", `[${entry.name}]`);
					lines.push(
						truncateToWidth(`${branch}${tag} ${entry.label}`, effectiveWidth),
					);
				}
			} else {
				const shown = toolCalls.slice(-MAX_COLLAPSED);
				const remaining = toolCalls.length - shown.length;
				lines.push(
					truncateToWidth(
						t.fg("dim", `  ├── …${remaining} earlier`),
						effectiveWidth,
					),
				);
				for (let i = 0; i < shown.length; i++) {
					const entry = shown[i];
					const isLast = i === shown.length - 1;
					const branch = isLast ? "  └── " : "  ├── ";
					const tag = t.fg("accent", `[${entry.name}]`);
					lines.push(
						truncateToWidth(`${branch}${tag} ${entry.label}`, effectiveWidth),
					);
				}
			}
		}
		return lines;
	};

	ctx.ui.setWidget(widgetKey, (tui, t) => {
		widgetTui = tui;
		return {
			render: (width?: number) => buildLines(t, width),
			invalidate: () => widgetTui?.requestRender(),
		};
	});

	const requestRender = () => widgetTui?.requestRender();

	const spinnerTimer = setInterval(() => {
		frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
		requestRender();
	}, 100);

	let result: Awaited<ReturnType<typeof runAgentSession>> | undefined;
	const maxSameModelAttempts = Math.max(
		1,
		config.execution.maxSameModelAttempts,
	);
	try {
		for (let attempt = 0; attempt < models.length; attempt++) {
			const model = models[attempt];
			// Reattempt on the same model before cycling — matches the main task
			// loop. Clear partial tool calls between failed attempts so the
			// widget reflects only the successful (or final) attempt.
			for (let same = 0; same < maxSameModelAttempts; same++) {
				result = await runAgentSession(
					prompt,
					projectDir,
					timeoutMs,
					(event) => {
						if (event.type === "tool_execution_start") {
							const label = formatToolArg(event.toolName, event.args);
							toolCalls.push({ name: event.toolName, label });
							requestRender();
						}
					},
					undefined,
					model,
					config.thinkingLevel,
					false, // noSkills=false — follow-up sessions load skills too
					(ctx.modelRegistry as any).runtime as ModelRuntime,
				);

				if (result.success) break;
				if (same < maxSameModelAttempts - 1) {
					toolCalls.length = 0;
					requestRender();
				}
			}

			if (result!.success) break;

			// If there's a next model to try, cycle; otherwise give up.
			if (attempt < models.length - 1) {
				// Clear partial tool calls from the failed attempt so the widget
				// reflects only the successful (or final) attempt.
				toolCalls.length = 0;
				requestRender();
			}
		}
	} finally {
		clearInterval(spinnerTimer);
		ctx.ui.setWidget(widgetKey, undefined);
	}

	// result is always set — the loop runs at least once (models.length >= 1)
	return { result: result!, toolCalls };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a model failover list for a follow-up session.
 *
 * The primary model goes first; the remaining models from the round-robin
 * pool are appended (deduped) so a flaky provider doesn't kill the commit
 * or review step. When there's no round-robin (sequential mode), the
 * primary model is returned as a single-element list.
 */
function buildFailoverModels(
	primary: unknown,
	roundRobin: ModelRoundRobin | null | undefined,
): unknown[] {
	const models: unknown[] = [primary];
	if (roundRobin) {
		for (const m of roundRobin.allModels) {
			if (m !== primary) models.push(m);
		}
	}
	return models;
}

// ─── Tool Call Formatting ────────────────────────────────────────────────

/**
 * Shorthand type for the model registry's find() shape.
 */
type ModelRegistryLike = { find(p: string, m: string): unknown };

/**
 * Resolve a model spec for a follow-up session (commit/review), falling back
 * to `currentModel` when the config field is blank or the registry can't
 * resolve it. Warns via `ctx.ui.notify` on resolution failure.
 */
function resolveFollowUpModel(
	ctx: ExtensionContext,
	spec: string,
	currentModel: unknown,
): unknown {
	return (
		resolveModelSpec(
			ctx.modelRegistry as ModelRegistryLike | undefined,
			spec,
			(msg) => ctx.ui.notify(msg, "warning"),
		) ?? currentModel
	);
}

/**
 * Run the auto-commit follow-up agent session.
 * Returns the commit messages, summary, tool calls, and success flag.
 */
async function runCommitSession(
	ctx: ExtensionContext,
	config: RalpiConfig,
	task: Task,
	projectDir: string,
	currentModel: unknown,
	roundRobin: ModelRoundRobin | null | undefined,
	sendChatMessage?: SendChatMessage,
): Promise<{
	commitMessages: string[];
	commitSummary: string;
	toolCalls: ToolCallEntry[];
	success: boolean;
}> {
	const status = getGitStatusPorcelain(projectDir);
	let diff = getGitDiff(projectDir);
	let diffNote = "";
	if (diff.length > MAX_DIFF_BYTES) {
		diffNote =
			"\n\n... (diff truncated: omitted " +
			(diff.length - MAX_DIFF_BYTES).toLocaleString() +
			" bytes; run `git diff` to view the full diff)";
		diff = diff.slice(0, MAX_DIFF_BYTES);
	}
	const commitPrompt = [
		`## Auto-Commit for Task ${task.id}: ${task.title}`,
		"",
		"The previous task is complete. There are uncommitted changes in the repository.",
		"",
		"Only commit changes you made while completing this task. Do not commit pre-existing changes, changes from other work, or files unrelated to this task.",
		"Review the git status and diff below to identify which changes are from your work, and stage only those files.",
		"",
		"Stage only the files relevant to this task with `git add <files>`, then create a meaningful git commit.",
		"Use a descriptive commit message and follow conventional commits format.",
		"Do NOT include the task number, task ID, or any ralpi task reference in the commit message. The commit message must describe only the work done — never mention the task ID (e.g. `task 03`, `#3`, etc.).",
		"",
		"### Current Changes (git status --porcelain)",
		"```text",
		status || "(no status output)",
		"```",
		"",
		"### Current Tracked Diff (git diff)",
		"```diff",
		diff || "(no tracked diff output)",
		diffNote,
		"```",
	].join("\n");

	const commitModel = resolveFollowUpModel(
		ctx,
		config.execution.commitModel,
		currentModel,
	);
	const commitModels = buildFailoverModels(commitModel, roundRobin);

	const { result: commitResult, toolCalls: commitToolCalls } =
		await runFollowUpSession(
			ctx,
			config,
			commitPrompt,
			projectDir,
			`commit for ${task.id} · ${task.title}`,
			`commit-${task.id}`,
			config.execution.commitTimeoutMs,
			commitModels,
		);

	if (commitResult.success) {
		const newCommits = captureGitCommits(projectDir);
		const commitMessages =
			newCommits.commitMessages.length > 0 ? newCommits.commitMessages : [];
		const commitSummary = newCommits.commitSummary || "";
		sendChatMessage?.(`✓ commit for ${task.id} · ${task.title}`, {
			toolCalls: commitToolCalls,
		});
		return {
			commitMessages,
			commitSummary,
			toolCalls: commitToolCalls,
			success: true,
		};
	}

	sendChatMessage?.(
		`~ commit for ${task.id} · ${task.title} — follow-up commit session failed: ${commitResult.error}`,
		{ toolCalls: commitToolCalls },
	);
	return {
		commitMessages: [],
		commitSummary: "",
		toolCalls: commitToolCalls,
		success: false,
	};
}

// ─── Batch Conflict Resolution ───────────────────────────────────────────────

/**
 * Resolve a merge conflict by spawning an agent session in the main repo.
 *
 * The merge was already attempted (and aborted) by `mergeWorktree` during
 * `executeTask`. This function re-attempts the merge to recreate the conflict
 * state, spawns an agent to resolve all conflict markers, stage, and commit,
 * then verifies completion. On success, the worktree is cleaned up and the
 * task is marked completed. On failure, the merge is aborted and the task
 * is marked failed (the worktree is retained for inspection).
 *
 * Runs after all tasks in a batch finish, so parallel task slots aren't
 * blocked waiting for conflict resolution.
 */
async function resolveConflictsSession(
	ctx: ExtensionContext,
	config: RalpiConfig,
	task: Task,
	project: Project,
	projectDir: string,
	worktree: WorktreeHandle,
	currentModel: unknown,
	roundRobin: ModelRoundRobin | null | undefined,
	progress: ProgressTracker,
	sendChatMessage?: SendChatMessage,
): Promise<void> {
	const { branch } = worktree;

	// Re-attempt the merge to recreate the conflict state in the main repo.
	const attempt = reattemptMerge(projectDir, branch);
	if (attempt.clean) {
		// No conflicts on re-attempt — complete the merge directly.
		if (completeMerge(projectDir)) {
			sendChatMessage?.(
				`✓ conflicts auto-resolved for ${task.id} · ${task.title}`,
			);
			removeWorktree(projectDir, worktree);
			progress.markCompleted(
				task.id,
				0, // duration already tracked in executeTask
				undefined,
				undefined,
				undefined,
				[],
				"",
				undefined,
				0,
			);
			try {
				updateTaskInFile(project.sourcePath, task.id, "completed");
			} catch {
				// Best-effort
			}
			return;
		}
		// completeMerge failed — fall through to mark failed.
		abortMerge(projectDir);
		progress.markFailed(task.id, `Failed to complete merge of ${branch}`);
		try {
			updateTaskInFile(project.sourcePath, task.id, "failed");
		} catch {
			// Best-effort
		}
		return;
	}

	// Conflicts exist — spawn a resolution agent session.
	const prompt = buildConflictResolutionPrompt(
		task,
		project,
		attempt.conflicts,
		branch,
		config.prompts.projectContext,
	);

	const commitModel = resolveFollowUpModel(
		ctx,
		config.execution.commitModel,
		currentModel,
	);
	const models = buildFailoverModels(commitModel, roundRobin);

	sendChatMessage?.(
		`⚑ resolving ${attempt.conflicts.length} conflict(s) for ${task.id} · ${task.title}...`,
	);

	const { result, toolCalls } = await runFollowUpSession(
		ctx,
		config,
		prompt,
		projectDir,
		`resolve conflicts for ${task.id}`,
		`resolve-${task.id}`,
		config.execution.commitTimeoutMs,
		models,
	);

	if (!result.success) {
		sendChatMessage?.(
			`~ conflict resolution for ${task.id} · ${task.title} — session failed: ${result.error}`,
			{ toolCalls },
		);
		abortMerge(projectDir);
		progress.markFailed(
			task.id,
			`Conflict resolution session failed: ${result.error}`,
		);
		try {
			updateTaskInFile(project.sourcePath, task.id, "failed");
		} catch {
			// Best-effort
		}
		return;
	}

	// Check if the agent actually resolved all conflicts and committed.
	if (hasMergeConflicts(projectDir)) {
		// Agent didn't resolve everything — abort and fail.
		sendChatMessage?.(
			`✗ ${task.id} · ${task.title} — conflict resolution incomplete, ${attempt.conflicts.length} file(s) still conflicted`,
			{ toolCalls },
		);
		abortMerge(projectDir);
		progress.markFailed(
			task.id,
			`Conflict resolution incomplete — unresolved conflicts remaining`,
		);
		try {
			updateTaskInFile(project.sourcePath, task.id, "failed");
		} catch {
			// Best-effort
		}
		return;
	}

	// Success — conflicts resolved and merge committed.
	sendChatMessage?.(`✓ conflicts resolved for ${task.id} · ${task.title}`, {
		toolCalls,
	});
	removeWorktree(projectDir, worktree);
	progress.markCompleted(
		task.id,
		0,
		undefined,
		undefined,
		undefined,
		[],
		"",
		undefined,
		0,
	);
	try {
		updateTaskInFile(project.sourcePath, task.id, "completed");
	} catch {
		// Best-effort
	}
}

/**
 * Strip control characters and newlines from a display label so it
 * does not break TUI layout (tree branches, text width calculation).
 */
function sanitizeLabel(s: string): string {
	// Replace newlines/carriage returns with spaces (multi-line commands
	// must fit on a single tree-branch line), then strip ASCII control
	// characters except \t (which is harmless) and keep printable chars.
	return s
		.replace(/\r?\n/g, " ")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
		.trim();
}

/**
 * Format a tool call argument into a short label.
 */
function formatToolArg(name: string, args: unknown): string {
	const a = args as Record<string, unknown>;
	switch (name) {
		case "bash":
			return sanitizeLabel(truncateMiddle(String(a.command ?? ""), 70));
		case "write":
		case "read":
			return sanitizeLabel(truncateMiddle(String(a.path ?? ""), 60));
		case "edit":
			return sanitizeLabel(truncateMiddle(String(a.path ?? ""), 60));
		case "grep":
			return sanitizeLabel(
				`${a.pattern ?? "?"} — ${truncateMiddle(String(a.path ?? ""), 40)}`,
			);
		case "find":
			return sanitizeLabel(`${a.path ?? "."} — ${a.glob ?? "*"}`);
		case "ls":
			return sanitizeLabel(truncateMiddle(String(a.path ?? "."), 60));
		default:
			return name;
	}
}

/**
 * Truncate a long string in the middle, keeping start and end visible.
 */
function truncateMiddle(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	const half = Math.floor((maxLen - 3) / 2);
	return s.slice(0, half) + "…" + s.slice(s.length - half);
}
