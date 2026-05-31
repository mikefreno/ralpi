import * as fs from "node:fs";
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
import { executeBatch, type SendChatMessage } from "./src/executor";
import {
	loadConfig,
	resolveTaskArg,
	formatProgressStatus,
	formatAllPRDsStatus,
	findProgressFile,
} from "./src/utils";

const COMMANDS = ["status", "resume", "next", "reset"] as const;

type ExecutionMode = "parallel" | "sequential";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/** Build the set of completed tasks from progress tracker and PRD checkboxes. */
function buildCompletedSet(
	progress: ProgressTracker,
	project: import("./src/types").Project,
): Set<string> {
	const completed = new Set(progress.getCompletedTaskIds());
	for (const task of project.tasks) {
		if (task.status === "completed") {
			completed.add(task.id);
		}
	}
	return completed;
}

/** Prompt user to select an execution mode with dependency validation. */
async function selectExecutionMode(
	ctx: ExtensionContext,
	project: import("./src/types").Project,
	taskFile: string,
): Promise<ExecutionMode> {
	const mode = await ctx.ui.select("Execution mode for this run?", [
		"Parallel (where dependencies allow)",
		"Sequential (one at a time)",
	]);
	const isParallel = mode?.startsWith("Parallel") ?? false;

	if (!isParallel) return "sequential";

	// Validate dependency graph for parallel mode
	if (Object.keys(project.dependencies).length === 0) {
		const hasDepsSection = await fs.promises
			.readFile(taskFile, "utf-8")
			.then((content) => /^##\s+Dependencies\s*$/m.test(content))
			.catch(() => false);

		if (hasDepsSection) {
			const choice = await ctx.ui.select(
				"Found ## Dependencies section but no valid dependencies were parsed.\n\n" +
					"This may be due to unsupported format. Parallel mode requires explicit dependencies.\n\n" +
					"See README.md for supported dependency formats:\n" +
					"- Arrow notation: `1 -> 2,3,4`\n" +
					"- Natural language: `13 depends on 17, 18, 19, 20`\n\n" +
					"Fall back to sequential mode?",
				["Yes, use sequential", "No, continue with parallel"],
			);
			if (choice?.startsWith("Yes")) {
				return "sequential";
			}
		}
	}

	return "parallel";
}

/** Build an execution plan based on the selected mode. */
function buildPlanByMode(
	mode: ExecutionMode,
	project: Parameters<typeof buildExecutionPlan>[0],
	completed: Set<string>,
) {
	return mode === "parallel"
		? buildExecutionPlan(project, completed)
		: buildSequentialPlan(project, completed);
}

/** Run all batches in a plan, updating the task file after each batch. */
async function executePlanBatches(
	plan: ReturnType<typeof buildPlanByMode>,
	project: Parameters<typeof buildExecutionPlan>[0],
	taskFile: string,
	config: import("./src/types").RalpiConfig,
	progress: ProgressTracker,
	ctx: ExtensionContext,
	mode: ExecutionMode,
	sendChatMessage?: SendChatMessage,
	projectDir?: string,
): Promise<void> {
	for (const batch of plan.batches) {
		if (progress.getState().paused) {
			ctx.ui.notify(
				"Execution paused. Use /ralpi resume to continue.",
				"warning",
			);
			return;
		}

		if (!Array.isArray(batch.tasks)) {
			throw new Error(
				`Batch ${
					batch.batchIndex
				} has invalid tasks: expected array, got ${typeof batch.tasks}`,
			);
		}

		await executeBatch(
			batch.tasks,
			project,
			config,
			progress,
			ctx,
			{ parallel: mode === "parallel" },
			sendChatMessage,
			projectDir,
		);

		for (const task of batch.tasks) {
			const status = progress.getTaskStatus(task.id);
			updateTaskInFile(taskFile, task.id, status);
		}
	}
}

// ─── Extension Entry ────────────────────────────────────────────────────────

export default function ralpiLoopExtension(pi: ExtensionAPI): void {
	// Register custom message renderer for ralpi progress messages.
	// Renders an expandable tool-call tree: collapsed shows last 3 + "N more",
	// expanded (Ctrl+O) shows every tool call.
	pi.registerMessageRenderer(
		"ralpi-progress",
		(message, { expanded }, theme) => {
			const details = message.details as
				| {
						phase?: string;
						toolCalls?: Array<{ name: string; label: string }>;
				  }
				| undefined;

			const MAX_COLLAPSED = 3;
			const lines: string[] = [];

			// Header line — e.g. "✓ 05 · billing-subscriptions-trials (2m 14s)"
			lines.push(String(message.content));

			// Build tool-call tree
			if (details?.toolCalls && details.toolCalls.length > 0) {
				const all = details.toolCalls;

				if (expanded) {
					// Expanded: show ALL tool calls
					for (let i = 0; i < all.length; i++) {
						const entry = all[i];
						const isLast = i === all.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = theme.fg("accent", `[${entry.name}]`);
						lines.push(`${branch}${tag} ${entry.label}`);
					}
				} else {
					// Collapsed: last N + "X more"
					const shown = all.slice(-MAX_COLLAPSED);
					const remaining = all.length - shown.length;

					if (remaining > 0) {
						lines.push(theme.fg("dim", `  ├── ${remaining} more`));
					}

					for (let i = 0; i < shown.length; i++) {
						const entry = shown[i];
						const isLast = i === shown.length - 1;
						const branch = isLast ? "  └── " : "  ├── ";
						const tag = theme.fg("accent", `[${entry.name}]`);
						lines.push(`${branch}${tag} ${entry.label}`);
					}
				}
			}

			const text = lines.join("\n");
			const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(text, 0, 0));
			return box;
		},
	);

	// Register the extension's prompts/ directory so Pi discovers @task-manager
	pi.on("resources_discover", async (_event, _ctx) => {
		const promptsDir = fs.existsSync(path.resolve(__dirname, "prompts"))
			? path.resolve(__dirname, "prompts")
			: path.resolve(__dirname, "..", "prompts");
		return {
			promptPaths: [promptsDir],
		};
	});

	pi.registerCommand("ralpi", {
		description:
			"Execute tasks from a task file using DAG-based dependency resolution",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);

			// Wraps pi.sendMessage() for posting status to the chat history.
			// Uses "ralpi-progress" customType with a "progress" phase so the
			// renderer omits the label prefix entirely (no [INFO] etc.).
			// Accepts an optional meta object with toolCalls for the expandable view.
			const sendProgress: SendChatMessage = (
				content: string,
				meta?: { toolCalls?: Array<{ name: string; label: string }> },
			) => {
				pi.sendMessage({
					customType: "ralpi-progress",
					content,
					display: true,
					details: { phase: "progress", toolCalls: meta?.toolCalls },
				});
			};

			// If no args, show plan. If first token looks like a path (@path, /path, ./path),
			// route to run so the execution mode prompt fires.
			if (parts.length === 0) {
				return handlePlan(ctx, parts);
			}
			if (looksLikePath(parts[0])) {
				return handleRun(
					ctx,
					parts,
					sendProgress,
					ctx.model,
					pi.getThinkingLevel(),
				);
			}

			const command = parts[0];
			switch (command) {
				case "run":
					return handleRun(
						ctx,
						parts.slice(1),
						sendProgress,
						ctx.model,
						pi.getThinkingLevel(),
					);
				case "plan":
					return handlePlan(ctx, parts.slice(1));
				case "status":
					return handleStatus(ctx, parts.slice(1));
				case "resume":
					return handleResume(
						ctx,
						parts.slice(1),
						sendProgress,
						ctx.model,
						pi.getThinkingLevel(),
					);
				case "next":
					return handleNext(
						ctx,
						parts.slice(1),
						sendProgress,
						ctx.model,
						pi.getThinkingLevel(),
					);
				case "reset":
					return handleReset(ctx, parts.slice(1));
				default: {
					// Auto-discover progress and offer resume
					const found = findProgressFile(process.cwd());
					if (found) {
						ctx.ui.notify(
							`Unknown command: ${command}\n\nFound existing progress in ${
								found.path
							}\nUse /ralpi resume to continue.\n\nAvailable: ${COMMANDS.join(
								", ",
							)}`,
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

// ─── /ralpi plan ─────────────────────────────────────────────────────────────

async function handlePlan(
	ctx: ExtensionContext,
	args: string[],
): Promise<void> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());
	const project = parseTaskFile(taskFile);
	if (!Array.isArray(project.tasks)) {
		throw new Error(
			`Parsed project from ${taskFile} has invalid tasks: expected array, got ${typeof project.tasks}`,
		);
	}

	const planPrompt = buildPlanPrompt(project);
	const plan = buildExecutionPlan(project, new Set());
	const formatted = formatExecutionPlan(plan);

	ctx.ui.notify(`${planPrompt}\n\n${formatted}`, "info");
}

// ─── /ralpi run ──────────────────────────────────────────────────────────────

async function handleRun(
	ctx: ExtensionContext,
	args: string[],
	sendChatMessage?: SendChatMessage,
	parentModel?: unknown,
	parentThinkingLevel?: unknown,
): Promise<void> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());

	// If targeting a specific task file and there's existing progress for it,
	// auto-resume instead of starting fresh
	const existingProgress = findProgressFile(process.cwd(), taskFile);
	if (existingProgress) {
		return handleResume(
			ctx,
			args.slice(0, 1),
			sendChatMessage,
			parentModel,
			parentThinkingLevel,
		);
	}

	// No existing progress for this task — check for any progress at all
	const found = findProgressFile(process.cwd());
	if (found && !args[0]) {
		// Offer to resume instead of starting fresh
		const shouldResume = await ctx.ui.select(
			"Found existing ralpi progress. Resume?",
			["Yes, resume", "No, start fresh"],
		);

		if (shouldResume?.startsWith("Yes")) {
			return handleResume(
				ctx,
				[],
				sendChatMessage,
				parentModel,
				parentThinkingLevel,
			);
		}
	}

	const projectDir = found
		? path.dirname(path.dirname(found.path))
		: process.cwd();

	const project = parseTaskFile(taskFile);
	const config = loadConfig(projectDir);
	config.model = parentModel ?? ctx.model;
	config.thinkingLevel = parentThinkingLevel;
	const progress = new ProgressTracker(projectDir, taskFile);

	const completed = buildCompletedSet(progress, project);
	const mode = await selectExecutionMode(ctx, project, taskFile);
	const plan = buildPlanByMode(mode, project, completed);

	// Show execution plan before starting so user can see batch breakdown
	const formattedPlan = formatExecutionPlan(plan);
	ctx.ui.notify(`${formattedPlan}\n\nStarting ${mode} execution...`, "info");

	await executePlanBatches(
		plan,
		project,
		taskFile,
		config,
		progress,
		ctx,
		mode,
		sendChatMessage,
		projectDir,
	);

	const state = progress.getState();
	const output = formatProgressStatus(state);

	const reflections = progress.getAllReflections();
	if (reflections.length > 0) {
		ctx.ui.notify(`${output}\n\n${formatReflections(reflections)}`, "info");
		return;
	}

	ctx.ui.notify(output, "info");
}

// ─── /ralpi status ───────────────────────────────────────────────────────────

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
			`No progress for ${path.basename(taskFile)}. ${
				project.tasks.length
			} tasks found.\nUse /ralpi run ${args[0]} to start.`,
			"info",
		);
		return;
	}

	const found = findProgressFile(process.cwd());
	if (!found) {
		ctx.ui.notify(
			"No .ralpi/progress.json found. Start with /ralpi run [task-file]",
			"warning",
		);
		return;
	}

	ctx.ui.notify(formatAllPRDsStatus(found.state), "info");
}

// ─── /ralpi resume ───────────────────────────────────────────────────────────

async function handleResume(
	ctx: ExtensionContext,
	args: string[],
	sendChatMessage?: SendChatMessage,
	parentModel?: unknown,
	parentThinkingLevel?: unknown,
): Promise<void> {
	let taskFile: string;
	let projectDir: string;
	let found: ReturnType<typeof findProgressFile>;

	if (args[0]) {
		taskFile = resolveTaskArg(args[0], process.cwd());
		found = findProgressFile(process.cwd(), taskFile);
		if (!found) {
			ctx.ui.notify(
				`No existing progress for ${args[0]}. Start with /ralpi run ${args[0]}`,
				"warning",
			);
			return;
		}
		projectDir = path.dirname(path.dirname(found.path));
	} else {
		found = findProgressFile(process.cwd());
		if (!found) {
			ctx.ui.notify(
				"No .ralpi/progress.json found. Start with /ralpi run [task-file]",
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
	if (!Array.isArray(project.tasks)) {
		throw new Error(
			`Parsed project from ${taskFile} has invalid tasks: expected array, got ${typeof project.tasks}`,
		);
	}
	const config = loadConfig(projectDir);
	config.model = parentModel ?? ctx.model;
	config.thinkingLevel = parentThinkingLevel;
	const progress = new ProgressTracker(projectDir, taskFile, found.prdKey);

	progress.setPaused(false);

	const completed = buildCompletedSet(progress, project);
	const mode = await selectExecutionMode(ctx, project, taskFile);
	const plan = buildPlanByMode(mode, project, completed);

	await executePlanBatches(
		plan,
		project,
		taskFile,
		config,
		progress,
		ctx,
		mode,
		sendChatMessage,
		projectDir,
	);

	ctx.ui.notify(formatProgressStatus(progress.getState()), "info");
}

// ─── /ralpi next ─────────────────────────────────────────────────────────────

async function handleNext(
	ctx: ExtensionContext,
	args: string[],
	sendChatMessage?: SendChatMessage,
	parentModel?: unknown,
	parentThinkingLevel?: unknown,
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
				"No .ralpi/progress.json found. Start with /ralpi run [task-file]",
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
	if (!Array.isArray(project.tasks)) {
		throw new Error(
			`Parsed project from ${taskFile} has invalid tasks: expected array, got ${typeof project.tasks}`,
		);
	}
	const config = loadConfig(projectDir);
	config.model = parentModel ?? ctx.model;
	config.thinkingLevel = parentThinkingLevel;
	const progress = new ProgressTracker(projectDir, taskFile, found?.prdKey);

	const completed = buildCompletedSet(progress, project);
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
			[task],
			project,
			config,
			progress,
			ctx,
			{ parallel: false },
			sendChatMessage,
			projectDir,
		);
		updateTaskInFile(taskFile, task.id, progress.getTaskStatus(task.id));
	}

	ctx.ui.notify(
		`Executed: ${nextBatch
			.map((t) => t.id)
			.join(", ")}\n\n${formatProgressStatus(progress.getState())}`,
		"info",
	);
}

// ─── /ralpi reset ────────────────────────────────────────────────────────────

async function handleReset(
	ctx: ExtensionContext,
	args: string[],
): Promise<void> {
	if (args[0]) {
		const taskFile = resolveTaskArg(args[0], process.cwd());
		const found = findProgressFile(process.cwd(), taskFile);
		const projectDir = found
			? path.dirname(path.dirname(found.path))
			: process.cwd();
		const progress = new ProgressTracker(projectDir, taskFile, found?.prdKey);
		progress.reset();
	} else {
		const found = findProgressFile(process.cwd());
		if (!found) {
			ctx.ui.notify(
				"No .ralpi/progress.json found. Start with /ralpi run [task-file]",
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
