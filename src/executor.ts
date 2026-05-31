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
	formatDuration,
} from "./utils";

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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
): Promise<{
	success: boolean;
	reflection?: Reflection;
	error?: string;
	durationMs: number;
	toolUsage?: ToolUsage;
	outputPreview?: string;
	sessionFile?: string;
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

	// Write prompt to .ralpi/ with timestamp (for debugging)
	const ralpiDir = path.join(projectDir, ".ralpi");
	ensureDir(ralpiDir);
	const promptFile = path.join(ralpiDir, `prompt-${startMs}.md`);
	writeFileSafe(promptFile, prompt);

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
		const buildLines = (t: typeof ctx.ui.theme): string[] => {
			const frame = t.fg("accent", SPINNER_FRAMES[frameIndex]);
			const lines = [`${frame} ${taskHeader}`];

			if (toolCalls.length > 0) {
				if (toolCalls.length <= MAX_COLLAPSED) {
					for (let i = 0; i < toolCalls.length; i++) {
						const entry = toolCalls[i];
						const isLast = i === toolCalls.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = t.fg("accent", `[${entry.name}]`);
						lines.push(`${branch}${tag} ${entry.label}`);
					}
				} else {
					const shown = toolCalls.slice(-MAX_COLLAPSED);
					const remaining = toolCalls.length - shown.length;
					lines.push(t.fg("dim", `  ├── …${remaining} earlier`));
					for (let i = 0; i < shown.length; i++) {
						const entry = shown[i];
						const isLast = i === shown.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = t.fg("accent", `[${entry.name}]`);
						lines.push(`${branch}${tag} ${entry.label}`);
					}
				}
			}
			return lines;
		};

		ctx.ui.setWidget(widgetKey, (tui, t) => {
			widgetTui = tui;
			return {
				render: () => buildLines(t),
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

	// Pre-create session file path so events stream to disk (avoids 300+ MB in-memory accumulation)
	const sessionsDir = path.join(ralpiDir, "sessions");
	ensureDir(sessionsDir);
	const sessionFilePath = path.join(sessionsDir, `${task.id}-${startMs}.txt`);

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
				}
				requestRender();
			}
		},
		undefined, // no abort signal
		sessionFilePath, // stream events to file
		config.model,
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
	} else {
		ctx.ui.setWidget(widgetKey, undefined);
	}

	if (!output.success) {
		sendChatMessage?.(`✗ ${taskHeader} — ${output.error}`);
		ctx.ui.notify(`Task ${task.id} failed: ${output.error}`, "error");
		return {
			success: false,
			error: output.error,
			durationMs,
			sessionFile: sessionFilePath, // events streamed to file for debugging
		};
	}

	const agentText = output.text;
	const toolUsage = output.toolUsage;

	// Capture git commits made during this task
	const { commitMessages, commitSummary } = captureGitCommits(projectDir);

	// Session file already written by runAgentSession (events streamed to disk)
	const sessionFile = sessionFilePath;

	// Build output preview (first 500 chars of agent text)
	const outputPreview =
		agentText.length > 500
			? agentText.slice(0, 500) + "\n... (truncated, see session file)"
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
		sessionFile,
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

	// Check if we should run parallel
	const shouldParallel =
		options?.parallel && tasks.length > 1 && config.execution.maxParallel > 0;

	if (shouldParallel) {
		await executeBatchParallel(
			tasks,
			project,
			config,
			progress,
			ctx,
			sendChatMessage,
			projectDir,
		);
		return;
	}

	// Execute sequentially
	for (const task of tasks) {
		await executeTask(
			task,
			project,
			config,
			progress,
			ctx,
			sendChatMessage,
			projectDir,
		);
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
): Promise<void> {
	const maxParallel = config.execution.maxParallel;
	const sharedState: ParallelWidgetState = new Map();

	// Register a single batch widget that renders ALL parallel tasks in ID order.
	const widgetKey = `ralpi-parallel-${Date.now()}`;
	let widgetTui: { requestRender(): void } | null = null;

	const buildBatchLines = (t: typeof ctx.ui.theme): string[] => {
		const lines: string[] = [];
		const sortedIds = Array.from(sharedState.keys()).sort();

		for (const id of sortedIds) {
			const entry = sharedState.get(id)!;
			const frame = entry.done
				? entry.success
					? "✓"
					: "✗"
				: t.fg("accent", SPINNER_FRAMES[entry.frameIndex]);
			lines.push(`${frame} ${entry.taskHeader}`);

			if (entry.toolCalls.length > 0) {
				if (entry.toolCalls.length <= MAX_COLLAPSED) {
					for (let i = 0; i < entry.toolCalls.length; i++) {
						const tc = entry.toolCalls[i];
						const isLast = i === entry.toolCalls.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = t.fg("accent", `[${tc.name}]`);
						lines.push(`${branch}${tag} ${tc.label}`);
					}
				} else {
					const shown = entry.toolCalls.slice(-MAX_COLLAPSED);
					const remaining = entry.toolCalls.length - shown.length;
					lines.push(t.fg("dim", `  ├── …${remaining} earlier`));
					for (let i = 0; i < shown.length; i++) {
						const tc = shown[i];
						const isLast = i === shown.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = t.fg("accent", `[${tc.name}]`);
						lines.push(`${branch}${tag} ${tc.label}`);
					}
				}
			}
		}
		return lines;
	};

	ctx.ui.setWidget(widgetKey, (tui, t) => {
		widgetTui = tui;
		return {
			render: () => buildBatchLines(t),
			invalidate: () => widgetTui?.requestRender(),
		};
	});

	// Single spinner timer drives all tasks in the batch
	const spinnerTimer = setInterval(() => {
		for (const entry of sharedState.values()) {
			if (!entry.done) {
				entry.frameIndex = (entry.frameIndex + 1) % SPINNER_FRAMES.length;
			}
		}
		widgetTui?.requestRender();
	}, 100);

	const results: Array<{ task: Task; result: Promise<any> }> = [];

	for (const task of tasks) {
		results.push({
			task,
			result: executeTask(
				task,
				project,
				config,
				progress,
				ctx,
				sendChatMessage,
				projectDir,
				sharedState,
			),
		});

		// Limit concurrency
		if (results.length >= maxParallel) {
			const first = results.shift();
			if (first) await first.result;
		}
	}

	// Wait for remaining tasks
	for (const { result } of results) {
		await result;
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
): Promise<void> {
	const maxRetries = config.execution.maxRetries;
	let retries = 0;

	while (retries <= maxRetries) {
		try {
			// Mark as in progress
			progress.markInProgress(task.id);

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
			);

			if (result.success) {
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
					result.sessionFile,
					result.outputPreview,
					result.commitMessages,
					result.commitSummary,
				);
				return;
			}

			// Task failed, check if we should retry
			if (retries < maxRetries) {
				retries = progress.incrementRetry(task.id);
				ctx.ui.notify(
					`Retrying task ${task.id} (${retries}/${maxRetries}): ${result.error}`,
					"warning",
				);

				// Exponential backoff
				const delay = config.execution.retryDelayMs * 2 ** (retries - 1);
				await sleep(delay);
			} else {
				// Max retries exceeded
				progress.markFailed(task.id, result.error || "Unknown error");
				throw new Error(`Task ${task.id} failed: ${result.error}`);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			progress.markFailed(task.id, errorMsg);
			throw error;
		}
	}
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
 * Format a tool call argument into a short label.
 */
function formatToolArg(name: string, args: unknown): string {
	const a = args as Record<string, unknown>;
	switch (name) {
		case "bash":
			return truncateMiddle(String(a.command ?? ""), 70);
		case "write":
		case "read":
			return truncateMiddle(String(a.path ?? ""), 60);
		case "edit":
			return truncateMiddle(String(a.path ?? ""), 60);
		case "grep":
			return `${a.pattern ?? "?"} — ${truncateMiddle(
				String(a.path ?? ""),
				40,
			)}`;
		case "find":
			return `${a.path ?? "."} — ${a.glob ?? "*"}`;
		case "ls":
			return truncateMiddle(String(a.path ?? "."), 60);
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
