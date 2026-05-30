import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { parseTaskFile, updateTaskInFile } from "./src/parser";
import {
	buildExecutionPlan,
	buildSequentialPlan,
	formatExecutionPlan,
	getReadyTasks,
} from "./src/dag";
import { ProgressTracker } from "./src/progress";
import { buildPlanPrompt } from "./src/prompts";
import { formatReflections } from "./src/reflection";
import { executeBatch } from "./src/executor";
import {
	loadConfig,
	resolveTaskArg,
	formatProgressStatus,
	formatAllPRDsStatus,
	findProgressFile,
} from "./src/utils";

const COMMANDS = ["status", "resume", "next", "reset"] as const;

/**
 * Detect if a token looks like a file path rather than a subcommand.
 * Matches: @path, /path, ./path, ../path, path/to/file, path.md, path.yaml
 */
function looksLikePath(token: string): boolean {
	return (
		token.startsWith("@") ||
		token.startsWith("/") ||
		token.startsWith("./") ||
		token.startsWith("../") ||
		token.includes("/") ||
		token.endsWith(".md") ||
		token.endsWith(".yaml") ||
		token.endsWith(".yml")
	);
}

// ─── Extension Entry ────────────────────────────────────────────────────────

export default function ralphLoopExtension(pi: ExtensionAPI): void {
	// Register custom message renderer for ralph progress messages
	pi.registerMessageRenderer(
		"ralph-progress",
		(message, { expanded }, theme) => {
			const details = message.details as
				| {
						taskId?: string;
						taskTitle?: string;
						phase?: string;
						timestamp?: number;
						durationMs?: number;
						toolUsage?: Record<string, number>;
						commits?: number;
						error?: string;
				  }
				| undefined;

			const phase = details?.phase ?? "info";
			const phaseLabel =
				phase === "starting"
					? theme.fg("accent", "[RUNNING]")
					: phase === "completed"
						? theme.fg("success", "[DONE]")
						: phase === "failed"
							? theme.fg("error", "[FAIL]")
							: phase === "batch_start"
								? theme.fg("accent", "[BATCH]")
								: phase === "retry"
									? theme.fg("warning", "[RETRY]")
									: phase === "progress"
										? ""
										: theme.fg("dim", "[INFO]");

			let text = phaseLabel
				? `${phaseLabel} ${message.content}`
				: String(message.content);

			// Show expanded details
			if (expanded && details) {
				const lines: string[] = [];
				if (details.taskId) lines.push(`  Task: ${details.taskId}`);
				if (details.durationMs) {
					const dur = formatDuration(details.durationMs);
					lines.push(`  Duration: ${dur}`);
				}
				if (details.toolUsage) {
					const tools = Object.entries(details.toolUsage)
						.filter(([, v]) => v > 0)
						.map(([k, v]) => `[${k}]: ${v}`)
						.join(" ");
					if (tools) lines.push(`  Tools: ${tools}`);
				}
				if (details.commits && details.commits > 0) {
					lines.push(`  Commits: ${details.commits}`);
				}
				if (details.error) {
					lines.push(`  Error: ${details.error}`);
				}
				if (details.timestamp) {
					const time = new Date(details.timestamp).toLocaleTimeString();
					lines.push(`  Time: ${time}`);
				}
				if (lines.length > 0) {
					text += "\n" + lines.join("\n");
				}
			}

			// Use Box with customMessageBg for consistent styling
			const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(text, 0, 0));
			return box;
		},
	);

	pi.registerCommand("ralph", {
		description:
			"Execute tasks from a task file using DAG-based dependency resolution",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);

			// Wraps pi.sendMessage() for posting status to the chat history.
			// Uses "ralph-progress" customType with a "progress" phase so the
			// renderer omits the label prefix entirely (no [INFO] etc.).
			const sendProgress = (content: string) => {
				pi.sendMessage({
					customType: "ralph-progress",
					content,
					display: true,
					details: { phase: "progress" },
				});
			};

			// If no args, show plan. If first token looks like a path (@path, /path, ./path),
			// route to run so the execution mode prompt fires.
			if (parts.length === 0) {
				return handlePlan(ctx, parts);
			}
			if (looksLikePath(parts[0])) {
				return handleRun(ctx, parts, sendProgress);
			}

			const command = parts[0];
			switch (command) {
				case "run":
					return handleRun(ctx, parts.slice(1), sendProgress);
				case "plan":
					return handlePlan(ctx, parts.slice(1));
				case "status":
					return handleStatus(ctx, parts.slice(1));
				case "resume":
					return handleResume(ctx, parts.slice(1), sendProgress);
				case "next":
					return handleNext(ctx, parts.slice(1), sendProgress);
				case "reset":
					return handleReset(ctx, parts.slice(1));
				default: {
					// Auto-discover progress and offer resume
					const found = findProgressFile(process.cwd());
					if (found) {
						ctx.ui.notify(
							`Unknown command: ${command}\n\nFound existing progress in ${found.path}\nUse /ralph resume to continue.\n\nAvailable: ${COMMANDS.join(", ")}`,
							"warning",
						);
					} else {
						ctx.ui.notify(
							`Unknown command: ${command}\nAvailable: ${COMMANDS.join(", ")}`,
							"error",
						);
					}
				}
			}
		},
	});
}

// ─── /ralph plan ─────────────────────────────────────────────────────────────

async function handlePlan(
	ctx: ExtensionContext,
	args: string[],
): Promise<void> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());
	const project = parseTaskFile(taskFile);

	const planPrompt = buildPlanPrompt(project);
	const plan = buildExecutionPlan(project, new Set());
	const formatted = formatExecutionPlan(plan);

	ctx.ui.notify(`${planPrompt}\n\n${formatted}`, "info");
}

// ─── /ralph run ──────────────────────────────────────────────────────────────

async function handleRun(
	ctx: ExtensionContext,
	args: string[],
	sendChatMessage?: (content: string) => void,
): Promise<void> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());

	// If targeting a specific task file and there's existing progress for it,
	// auto-resume instead of starting fresh
	const existingProgress = findProgressFile(process.cwd(), taskFile);
	if (existingProgress) {
		return handleResume(ctx, [args[0]!], sendChatMessage);
	}

	// No existing progress for this task — check for any progress at all
	const found = findProgressFile(process.cwd());
	if (found && !args[0]) {
		// Offer to resume instead of starting fresh
		const shouldResume = await ctx.ui.select(
			"Found existing ralph progress. Resume?",
			["Yes, resume", "No, start fresh"],
		);

		if (shouldResume?.startsWith("Yes")) {
			return handleResume(ctx, [], sendChatMessage);
		}
	}

	const project = parseTaskFile(taskFile);

	// Determine projectDir: prefer existing .ralph/ location, otherwise use cwd
	const projectDir = found
		? path.dirname(path.dirname(found.path))
		: process.cwd();

	const config = loadConfig(projectDir);
	const progress = new ProgressTracker(projectDir, taskFile);

	// Set initial status
	ctx.ui.setStatus(
		"ralph",
		`Starting ${project.tasks.length} tasks from ${path.basename(taskFile)}`,
	);

	const completed = new Set(progress.getCompletedTaskIds());

	// Ask user for execution mode
	const mode = await ctx.ui.select("Execution mode for this run?", [
		"Parallel (DAG-optimized)",
		"Sequential (one at a time)",
	]);
	const useParallel = mode?.startsWith("Parallel");

	// Sequential mode: use buildSequentialPlan to avoid 29-task mega-batches
	const plan = useParallel
		? buildExecutionPlan(project, completed)
		: buildSequentialPlan(project, completed);

	for (const batch of plan.batches) {
		if (progress.getState().paused) {
			ctx.ui.notify(
				"Execution paused. Use /ralph resume to continue.",
				"warning",
			);
			return;
		}

		await executeBatch(
			batch.batchIndex,
			batch.tasks,
			project,
			config,
			progress,
			ctx as any,
			{ parallel: useParallel },
			sendChatMessage,
		);

		for (const task of batch.tasks) {
			const status = progress.getTaskStatus(task.id);
			updateTaskInFile(taskFile, task.id, status);
		}
	}

	const state = progress.getState();
	const output = formatProgressStatus(state);

	const reflections = progress.getAllReflections();
	if (reflections.length > 0) {
		ctx.ui.notify(`${output}\n\n${formatReflections(reflections)}`, "info");
		return;
	}

	ctx.ui.notify(output, "info");
}

// ─── /ralph status ───────────────────────────────────────────────────────────

async function handleStatus(
	ctx: ExtensionContext,
	args: string[],
): Promise<void> {
	if (args[0]) {
		const taskFile = resolveTaskArg(args[0], process.cwd());
		const existingProgress = findProgressFile(process.cwd(), taskFile);
		if (existingProgress) {
			const projectDir = path.dirname(path.dirname(existingProgress.path));
			const progress = new ProgressTracker(
				projectDir,
				taskFile,
				existingProgress.prdKey,
			);
			ctx.ui.notify(formatProgressStatus(progress.getState()), "info");
			return;
		}
		// No progress yet for this task — parse and show plan instead
		const project = parseTaskFile(taskFile);
		ctx.ui.notify(
			`No progress for ${path.basename(taskFile)}. ${project.tasks.length} tasks found.\nUse /ralph run ${args[0]} to start.`,
			"info",
		);
		return;
	}

	const found = findProgressFile(process.cwd());
	if (!found) {
		ctx.ui.notify(
			"No .ralph/progress.json found. Start with /ralph run [task-file]",
			"warning",
		);
		return;
	}

	ctx.ui.notify(formatAllPRDsStatus(found.state), "info");
}

// ─── /ralph resume ───────────────────────────────────────────────────────────

async function handleResume(
	ctx: ExtensionContext,
	args: string[],
	sendChatMessage?: (content: string) => void,
): Promise<void> {
	// If a task file arg is provided, find progress for that specific PRD
	let taskFile: string;
	let projectDir: string;
	let found: ReturnType<typeof findProgressFile>;

	if (args[0]) {
		taskFile = resolveTaskArg(args[0], process.cwd());
		found = findProgressFile(process.cwd(), taskFile);
		if (!found) {
			ctx.ui.notify(
				`No existing progress for ${args[0]}. Start with /ralph run ${args[0]}`,
				"warning",
			);
			return;
		}
		projectDir = path.dirname(path.dirname(found.path));
	} else {
		found = findProgressFile(process.cwd());
		if (!found) {
			ctx.ui.notify(
				"No .ralph/progress.json found. Start with /ralph run [task-file]",
				"warning",
			);
			return;
		}
		projectDir = path.dirname(path.dirname(found.path));
		// For no-arg resume, use the first PRD's source path or legacy sourcePath
		taskFile = found.state.prds
			? Object.values(found.state.prds)[0].sourcePath
			: found.state.sourcePath;
	}

	const project = parseTaskFile(taskFile);
	const config = loadConfig(projectDir);
	const progress = new ProgressTracker(projectDir, taskFile, found.prdKey);

	progress.setPaused(false);

	// Set resume status
	ctx.ui.setStatus("ralph", `Resuming from ${path.basename(taskFile)}`);

	const completed = new Set(progress.getCompletedTaskIds());

	// Ask user for execution mode
	const mode = await ctx.ui.select("Execution mode for this resume?", [
		"Parallel (DAG-optimized)",
		"Sequential (one at a time)",
	]);
	const useParallel = mode?.startsWith("Parallel");

	// Sequential mode: use buildSequentialPlan to avoid 29-task mega-batches
	const plan = useParallel
		? buildExecutionPlan(project, completed)
		: buildSequentialPlan(project, completed);

	for (const batch of plan.batches) {
		await executeBatch(
			batch.batchIndex,
			batch.tasks,
			project,
			config,
			progress,
			ctx as any,
			{ parallel: useParallel },
			sendChatMessage,
		);

		for (const task of batch.tasks) {
			const status = progress.getTaskStatus(task.id);
			updateTaskInFile(taskFile, task.id, status);
		}
	}

	ctx.ui.notify(formatProgressStatus(progress.getState()), "info");
}

// ─── /ralph next ─────────────────────────────────────────────────────────────

async function handleNext(
	ctx: ExtensionContext,
	args: string[],
	sendChatMessage?: (content: string) => void,
): Promise<void> {
	let taskFile: string;
	let projectDir: string;
	let found: ReturnType<typeof findProgressFile>;

	if (args[0]) {
		taskFile = resolveTaskArg(args[0], process.cwd());
		found = findProgressFile(process.cwd(), taskFile);
		if (found) {
			projectDir = path.dirname(path.dirname(found.path));
		} else {
			projectDir = process.cwd();
		}
	} else {
		found = findProgressFile(process.cwd());
		if (!found) {
			ctx.ui.notify(
				"No .ralph/progress.json found. Start with /ralph run [task-file]",
				"warning",
			);
			return;
		}
		taskFile = found.state.prds
			? Object.values(found.state.prds)[0].sourcePath
			: found.state.sourcePath;
		projectDir = path.dirname(path.dirname(found.path));
	}

	const project = parseTaskFile(taskFile);
	const config = loadConfig(projectDir);
	const progress = new ProgressTracker(projectDir, taskFile, found?.prdKey);

	const completed = new Set(progress.getCompletedTaskIds());
	const ready = getReadyTasks(project, completed);

	if (ready.length === 0) {
		ctx.ui.notify(
			"No tasks ready to execute. All tasks completed or blocked.",
			"info",
		);
		return;
	}

	const nextBatch = ready.slice(
		0,
		config.execution.maxParallel || ready.length,
	);

	for (const task of nextBatch) {
		await executeBatch(
			0,
			[task],
			project,
			config,
			progress,
			ctx as any,
			undefined,
			sendChatMessage,
		);
		updateTaskInFile(taskFile, task.id, progress.getTaskStatus(task.id));
	}

	ctx.ui.notify(
		`Executed: ${nextBatch.map((t) => t.id).join(", ")}\n\n${formatProgressStatus(progress.getState())}`,
		"info",
	);
}

// ─── /ralph reset ────────────────────────────────────────────────────────────

async function handleReset(
	ctx: ExtensionContext,
	args: string[],
): Promise<void> {
	let projectDir: string;
	if (args[0]) {
		const taskFile = resolveTaskArg(args[0], process.cwd());
		const found = findProgressFile(process.cwd(), taskFile);
		projectDir = found ? path.dirname(path.dirname(found.path)) : process.cwd();
		const progress = new ProgressTracker(projectDir, taskFile, found?.prdKey);
		progress.reset();
	} else {
		const found = findProgressFile(process.cwd());
		if (!found) {
			ctx.ui.notify(
				"No .ralph/progress.json found. Start with /ralph run [task-file]",
				"warning",
			);
			return;
		}
		const projectDir = path.dirname(path.dirname(found.path));
		const progress = new ProgressTracker(
			projectDir,
			found.state.prds
				? Object.values(found.state.prds)[0].sourcePath
				: found.state.sourcePath,
		);
		progress.reset();
	}

	ctx.ui.notify("Progress reset. All task statuses cleared.", "info");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${seconds}s`;
}
