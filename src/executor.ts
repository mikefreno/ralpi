import * as path from "node:path";
import type { Task, Project, Reflection, ToolUsage } from "./types";
import type { RalphConfig } from "./types";
import type { ProgressTracker } from "./progress";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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

// ─── Run Single Task ────────────────────────────────────────────────────────

/**
 * Execute a single task by spawning an async Pi agent session.
 * Non-blocking — the TUI remains responsive throughout.
 */
export async function runTask(
	task: Task,
	project: Project,
	config: RalphConfig,
	depReflections: Reflection[],
	ctx: ExtensionCommandContext,
	sendChatMessage?: SendChatMessage,
	projectDir: string = project.sourceDir,
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

	// Write prompt to .ralph/ with timestamp (for debugging)
	const ralphDir = path.join(projectDir, ".ralph");
	ensureDir(ralphDir);
	const promptFile = path.join(ralphDir, `prompt-${startMs}.md`);
	writeFileSafe(promptFile, prompt);

	// Footer shows just the task title (no batch prefix)
	ctx.ui.setStatus("ralph", task.title);

	const taskHeader = `${task.id} · ${task.title}`;

	// Live progress widget above the editor — animated spinner + tool call updates
	// Using setWidget instead of setWorkingMessage because the working message area
	// is only visible during parent agent streaming, not during extension command execution.
	const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let frameIndex = 0;
	let lastToolLabel = "";
	const theme = ctx.ui.theme;

	const toolCalls: ToolCallEntry[] = [];

	const updateWidget = () => {
		const frame = theme.fg("accent", SPINNER_FRAMES[frameIndex]);
		const lines = [`${frame} ${taskHeader}`];
		if (toolCalls.length > 0) {
			lines.push(
				theme.fg(
					"dim",
					`  ${toolCalls.length} tool${toolCalls.length !== 1 ? "s" : ""} · ${lastToolLabel}`,
				),
			);
		}
		ctx.ui.setWidget("ralph-task", lines);
	};

	// Smooth spinner animation at 100ms intervals
	const spinnerTimer = setInterval(() => {
		frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
		updateWidget();
	}, 100);

	// Initial display
	updateWidget();

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
				// Update widget with latest tool call info
				lastToolLabel = `[${event.toolName}] ${label}`;
				updateWidget();
			}
		},
	);

	const durationMs = Date.now() - startMs;

	// Clear progress widget and status after task finishes
	clearInterval(spinnerTimer);
	ctx.ui.setWidget("ralph-task", undefined);
	ctx.ui.setStatus("ralph", undefined);

	if (!output.success) {
		sendChatMessage?.(`✗ ${taskHeader} — ${output.error}`);
		ctx.ui.notify(`Task ${task.id} failed: ${output.error}`, "error");
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

	// Save full session transcript to .ralph/sessions/
	const sessionFile = saveSessionOutput(
		projectDir,
		task.id,
		JSON.stringify(output.events, null, 2),
	);

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

// ─── Save Session Output ────────────────────────────────────────────────────

function saveSessionOutput(
	sourceDir: string,
	taskId: string,
	output: string,
): string {
	const sessionsDir = path.join(sourceDir, ".ralph", "sessions");
	ensureDir(sessionsDir);
	const fileName = `${taskId}-${Date.now()}.txt`;
	const filePath = path.join(sessionsDir, fileName);
	writeFileSafe(filePath, output);
	return filePath;
}

// ─── Execute Batch ───────────────────────────────────────────────────────────

/**
 * Execute a batch of tasks (sequentially or in parallel)
 */
export async function executeBatch(
	_batchIndex: number,
	tasks: Task[],
	project: Project,
	config: RalphConfig,
	progress: ProgressTracker,
	ctx: ExtensionCommandContext,
	options?: { parallel?: boolean },
	sendChatMessage?: SendChatMessage,
	projectDir?: string,
): Promise<void> {
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
	config: RalphConfig,
	progress: ProgressTracker,
	ctx: ExtensionCommandContext,
	sendChatMessage?: SendChatMessage,
	projectDir?: string,
): Promise<void> {
	const maxParallel = config.execution.maxParallel;
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
}

// ─── Execute Single Task with Retry ──────────────────────────────────────────

async function executeTask(
	task: Task,
	project: Project,
	config: RalphConfig,
	progress: ProgressTracker,
	ctx: ExtensionCommandContext,
	sendChatMessage?: SendChatMessage,
	projectDir: string = project.sourceDir,
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
	config: RalphConfig,
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
			return `${a.pattern ?? "?"} — ${truncateMiddle(String(a.path ?? ""), 40)}`;
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
