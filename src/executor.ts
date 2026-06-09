import { truncateToWidth } from "@earendil-works/pi-tui";
import * as path from "node:path";
import type { Task, Project, Reflection, ToolUsage } from "./types";
import type { RalpiConfig } from "./types";
import type { ProgressTracker } from "./progress";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTaskPrompt } from "./prompts";
import { extractReflection } from "./reflection";
import {
	runAgentSession,
	writeFileSafe,
	ensureDir,
	captureGitCommits,
	hasUncommittedChanges,
	getGitStatusPorcelain,
	getGitDiff,
	formatDuration,
} from "./utils";
import { updateTaskInFile } from "./parser";

/** Optional callback to post a progress message into the chat history. */
export type SendChatMessage = (
	content: string,
	/** Extra data passed to the message renderer for the expanded view. */
	meta?: { toolCalls?: ToolCallEntry[] },
) => void;

export interface ToolCallEntry {
	name: string;
	label: string;
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
		);
		return;
	}

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
): Promise<void> {
	const maxRetries = config.execution.maxRetries;

	// Model failover: when a provider/API is down, cycle through available models.
	// result.success === false always means an agent-session failure (API error,
	// provider unreachable, etc.), not a task-work error.
	const maxModelAttempts = roundRobin ? roundRobin.length : 1;
	let modelAttempt = 0;
	let currentModel: unknown = assignedModel ?? config.model;

	while (modelAttempt < maxModelAttempts) {
		// On subsequent model attempts, advance to the next model.
		// Uses advance() instead of assign() so we don't get stuck on
		// the same freed slot when the current model is down.
		if (modelAttempt > 0 && roundRobin) {
			currentModel = roundRobin.advance(task.id);
		}

		let retries = 0;
		while (retries <= maxRetries) {
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

				// Run the task
				const result = await runTask(
					task,
					project,
					config,
					depReflections,
					ctx,
					sendChatMessage,
					projectDir,
					parallelState,
					currentModel,
					batchRender,
				);

				if (result.success) {
					// ── Auto-Commit: Trigger follow-up agent session for uncommitted changes ──
					let finalCommitMessages = result.commitMessages ?? [];
					let finalCommitSummary = result.commitSummary ?? "";

					try {
						if (hasUncommittedChanges(projectDir)) {
							const status = getGitStatusPorcelain(projectDir);
							const diff = getGitDiff(projectDir);
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
								"",
								"### Current Changes (git status --porcelain)",
								"```text",
								status || "(no status output)",
								"```",
								"",
								"### Current Tracked Diff (git diff)",
								"```diff",
								diff || "(no tracked diff output)",
								"```",
							].join("\n");

							// Use a short timeout for the commit session (60s should be enough)
							const commitTimeout = Math.min(
								60_000,
								config.execution.timeoutMs,
							);
							const commitResult = await runAgentSession(
								commitPrompt,
								projectDir,
								commitTimeout,
								undefined,
								undefined,
								currentModel,
								config.thinkingLevel,
							);

							if (commitResult.success) {
								// Re-capture commits made during this follow-up session
								const newCommits = captureGitCommits(projectDir);
								if (newCommits.commitMessages.length > 0) {
									finalCommitMessages = [
										...finalCommitMessages,
										...newCommits.commitMessages,
									];
									finalCommitSummary = finalCommitSummary
										? `${finalCommitSummary}; ${newCommits.commitSummary}`
										: newCommits.commitSummary;
								}
								sendChatMessage?.(`✓ commit for ${task.id} · ${task.title}`);
							} else {
								sendChatMessage?.(
									`~ commit for ${task.id} · ${task.title} — follow-up commit session failed: ${commitResult.error}`,
								);
							}
						}
					} catch (error) {
						// Don't fail the task if auto-commit fails
						sendChatMessage?.(
							`~ commit for ${task.id} · ${task.title} — auto-commit error: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}

					// Save reflection
					if (result.reflection) {
						saveReflectionToFile(projectDir, config, result.reflection);
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
				// If we have more models, cycle immediately — don't waste retries.
				if (roundRobin && modelAttempt < maxModelAttempts - 1) {
					// Don't release — advance() already handles the transition.
					// release() would put the slot in freeSlots, then assign()
					// would pick it right back up, getting stuck on the same model.
					modelAttempt++;
					sendChatMessage?.(
						`~ ${task.id} · ${task.title} — trying model ${modelAttempt + 1}/${maxModelAttempts} (previous: ${result.error})`,
					);
					break; // exit retry loop, cycle to next model
				}

				// No more models — use normal retry logic
				if (retries < maxRetries) {
					retries = progress.incrementRetry(task.id);
					sendChatMessage?.(
						`~ ${task.id} · ${task.title} — retrying (${retries}/${maxRetries}): ${result.error}`,
					);

					// Exponential backoff
					const delay = config.execution.retryDelayMs * 2 ** (retries - 1);
					await sleep(delay);
				} else {
					// Max retries exceeded
					progress.markFailed(task.id, result.error || "Unknown error");
					// Don't update PRD — retry exhaustion is transient, not terminal
					sendChatMessage?.(`✗ ${task.id} · ${task.title} — ${result.error}`);
					ctx.ui.notify(
						`Task ${task.id} failed after ${maxRetries} retries: ${
							result.error || "Unknown error"
						}`,
						"error",
					);
					return;
				}
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
				return;
			}
		}

		// If we broke out (model cycling), continue the outer loop
		modelAttempt++;
	}

	// All models exhausted — release the slot
	roundRobin?.release(task.id);
	batchRender?.();
	progress.markFailed(task.id, "All configured models exhausted");
	// Don't update PRD — model exhaustion is transient, not terminal
	sendChatMessage?.(
		`✗ ${task.id} · ${task.title} — all ${maxModelAttempts} models exhausted`,
	);
	ctx.ui.notify(
		`Task ${task.id} failed: all configured models exhausted`,
		"error",
	);
}

// ─── Save Reflection to File ────────────────────────────────────────────────

function saveReflectionToFile(
	sourceDir: string,
	config: RalpiConfig,
	reflection: Reflection,
): void {
	const reflectionsDir = path.join(sourceDir, config.paths.reflectionsDir);
	ensureDir(reflectionsDir);
	const filePath = path.join(reflectionsDir, `${reflection.taskId}.json`);
	writeFileSafe(filePath, JSON.stringify(reflection, null, 2));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tool Call Formatting ────────────────────────────────────────────────

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
