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
	formatDependencyChain,
	formatExecutionPlan,
} from "./src/dag";
import { ProgressTracker } from "./src/progress";
import { buildPlanPrompt } from "./src/prompts";
import { formatReflections } from "./src/reflection";
import {
	executeBatch,
	SPINNER_FRAMES,
	type SendChatMessage,
} from "./src/executor";
import {
	loadConfig,
	resolveTaskArg,
	formatProgressStatus,
	findProgressFile,
	writeLoopActive,
	deleteLoopActive,
	readLoopActive,
	findRalpiDir,
} from "./src/utils";

const COMMANDS = ["plan", "resume", "reset"] as const;

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
	config: import("./src/types").RalpiConfig,
): Promise<ExecutionMode> {
	const mode = await ctx.ui.select("Execution mode for this run?", [
		`Parallel (where dependencies allow)[${config.execution.maxParallel} max]`,
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
	// Write loop-active marker so widgets can be re-instantiated after a reload
	if (projectDir) {
		const allTaskIds = plan.batches.flatMap((b) => b.tasks.map((t) => t.id));
		writeLoopActive(projectDir, {
			taskFile,
			mode,
			startedAt: new Date().toISOString(),
			taskIds: allTaskIds,
			prdKey: progress.getKey(),
		});
	}

	// Track failed task IDs across batches to block downstream tasks
	const failedTaskIds = new Set(progress.getFailedTaskIds());

	try {
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

			// Update failed task IDs after batch completes
			const newFailed = progress.getFailedTaskIds();
			for (const id of newFailed) {
				failedTaskIds.add(id);
			}

			// In sequential mode, stop after any failure
			if (mode === "sequential" && failedTaskIds.size > 0) {
				break;
			}

			// In parallel mode, rebuild the plan to filter out newly blocked tasks
			if (mode === "parallel") {
				// Use buildCompletedSet to include file-based [x] completions
				// (progress.getCompletedTaskIds() only knows about tasks completed
				// during THIS execution session — tasks that were already [x] in the
				// file before the run started would be re-included and re-executed).
				const completed = buildCompletedSet(progress, project);
				const newPlan = buildExecutionPlan(
					project,
					completed,
					undefined,
					failedTaskIds,
				);

				// Keep processed batches (up to current batch), replace the rest
				// with the fresh plan — its batchIndex restarts at 0, so filtering
				// by batchIndex > currentIdx would incorrectly drop the next batch.
				const processedCount = plan.batches.indexOf(batch) + 1;
				plan.batches.length = processedCount;
				plan.batches.push(...newPlan.batches);

				// Skip if nothing remaining
				if (plan.batches.length === processedCount) {
					break;
				}
			}
		}
	} finally {
		if (projectDir) {
			deleteLoopActive(projectDir);
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

	// ─── Reload detection: re-instantiate widgets when session reloads ──────
	//
	// When the user types /reload while ralpi tasks are executing, the old
	// ExtensionContext is torn down and widgets (created via ctx.ui.setWidget)
	// disappear. This handler detects the reload, reads the persisted loop-active
	// marker and progress.json, and re-creates live-status widgets that show
	// task progress with spinner animation and tool calls from session files.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "reload") return;

		// Find the ralpi project directory
		const projectDir = findRalpiDir(ctx.cwd);
		if (!projectDir) return;

		// Check if a task execution loop was active before the reload
		const loopState = readLoopActive(projectDir);
		if (!loopState) return;

		// Load progress state
		let abortPolling = false;
		const progressPath = path.join(projectDir, ".ralpi", "progress.json");
		const sessionsDir = path.join(projectDir, ".ralpi", "sessions");

		// Parse the task file to get task titles
		const titleMap = new Map<string, string>();
		try {
			const project = parseTaskFile(loopState.taskFile);
			for (const task of project.tasks) {
				titleMap.set(task.id, task.title);
			}
		} catch {
			// If parsing fails, just use IDs without titles
		}

		/** Read recent tool calls from a task's session file. */
		const readRecentToolCalls = (
			taskId: string,
			maxLines = 30,
		): Array<{ name: string; label: string }> => {
			try {
				const files = fs
					.readdirSync(sessionsDir)
					.filter((f) => f.startsWith(taskId + "-"))
					.sort();
				if (files.length === 0) return [];
				const sessionPath = path.join(sessionsDir, files[files.length - 1]);
				const content = fs.readFileSync(sessionPath, "utf-8");
				const lines = content
					.split("\n")
					.filter((l) => l.trim())
					.slice(-maxLines);
				const calls: Array<{ name: string; label: string }> = [];
				for (const line of lines) {
					try {
						const event = JSON.parse(line);
						if (event.type === "tool_execution_start") {
							calls.push({
								name: event.toolName,
								label: formatToolLabel(event.toolName, event.args),
							});
						}
					} catch {
						// Skip malformed lines
					}
				}
				return calls;
			} catch {
				return [];
			}
		};

		/**
		 * Strip control characters and newlines from a display label so it
		 * does not break TUI layout (tree branches, text width calculation).
		 */
		function sanitizeLabel(s: string): string {
			return s
				.replace(/\r?\n/g, " ")
				.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
				.trim();
		}

		/** Format a tool call argument into a short label. */
		function formatToolLabel(name: string, args: unknown): string {
			const a = args as Record<string, unknown> | undefined;
			if (!a) return name;
			if (name === "bash")
				return sanitizeLabel(String(a.command ?? "").slice(0, 70));
			if (name === "write" || name === "read" || name === "edit")
				return sanitizeLabel(String(a.path ?? "").slice(0, 60));
			if (name === "grep")
				return sanitizeLabel(
					`${a.pattern ?? "?"} — ${String(a.path ?? "").slice(0, 40)}`,
				);
			if (name === "find")
				return sanitizeLabel(`${a.path ?? "."} — ${a.glob ?? "*"}`);
			if (name === "ls")
				return sanitizeLabel(String(a.path ?? ".").slice(0, 60));
			return name;
		}

		/** Re-read progress from disk (old tasks still writing to it). */
		const readTasks = (): Record<string, { status: string }> | null => {
			try {
				const raw = fs.readFileSync(progressPath, "utf-8");
				const parsed = JSON.parse(raw) as Record<string, any>;
				return parsed.prds?.[loopState.prdKey]?.tasks ?? parsed.tasks ?? null;
			} catch {
				return null;
			}
		};

		// Early exit: if all tasks already finished during the reload, just clean up
		const initialTasks = readTasks();
		if (initialTasks) {
			const remaining = Object.values(initialTasks).filter(
				(t) => t.status === "in_progress",
			).length;
			if (remaining === 0) {
				ctx.ui.notify("All ralpi tasks completed during reload.", "info");
				deleteLoopActive(projectDir);
				return;
			}
		}

		// Show a status notification for the reconnect
		const taskCount = loopState.taskIds.length;
		ctx.ui.notify(
			`Reconnected to running ralpi execution (${taskCount} tasks, ${loopState.mode} mode)`,
			"info",
		);

		// Shared state for the widget
		let tickCount = 0;
		const MAX_COLLAPSED = 3;

		if (loopState.mode === "parallel") {
			// ── Parallel mode: single batch widget ──
			const widgetKey = `ralpi-parallel-reconnect-${Date.now()}`;
			let widgetTui: { requestRender(): void } | null = null;

			const buildBatchLines = (t: typeof ctx.ui.theme): string[] => {
				const tasks = readTasks();
				if (!tasks) return [t.fg("dim", "(waiting for progress...)")];

				const lines: string[] = [];
				// Only show tasks that have started (in_progress, completed, failed).
				// Pending/unstarted tasks are noise after a reload.
				const sortedIds = [...loopState.taskIds].sort().filter((id) => {
					const info = tasks[id];
					return info && info.status !== "pending";
				});

				// If no tasks have started yet, show nothing — polling will pick up
				// changes within 500ms.
				if (sortedIds.length === 0) return [t.fg("dim", "(starting tasks...)")];

				for (const id of sortedIds) {
					const info = tasks[id]!;
					const title = titleMap.get(id);
					const header = title ? `${id} · ${title}` : id;

					// Status icon
					if (info.status === "completed") {
						lines.push(`${t.fg("success", "✓")} ${header}`);
					} else if (info.status === "failed") {
						lines.push(`${t.fg("error", "✗")} ${header}`);
					} else if (info.status === "in_progress") {
						const frame = t.fg(
							"accent",
							SPINNER_FRAMES[tickCount % SPINNER_FRAMES.length],
						);
						lines.push(`${frame} ${header}`);

						// Show recent tool calls for active tasks
						const toolCalls = readRecentToolCalls(id);
						if (toolCalls.length > 0) {
							if (toolCalls.length <= MAX_COLLAPSED) {
								for (let i = 0; i < toolCalls.length; i++) {
									const tc = toolCalls[i];
									const isLast = i === toolCalls.length - 1;
									const branch = isLast ? "  └── " : "  ├── ";
									lines.push(
										`${branch}${t.fg("accent", `[${tc.name}]`)} ${tc.label}`,
									);
								}
							} else {
								const shown = toolCalls.slice(-MAX_COLLAPSED);
								const remaining = toolCalls.length - shown.length;
								lines.push(t.fg("dim", `  ├── …${remaining} earlier`));
								for (let i = 0; i < shown.length; i++) {
									const tc = shown[i];
									const isLast = i === shown.length - 1;
									const branch = isLast ? "  └── " : "  ├── ";
									lines.push(
										`${branch}${t.fg("accent", `[${tc.name}]`)} ${tc.label}`,
									);
								}
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

			// 100ms tick: advances spinner frame every tick, refreshes
			// progress + tool calls every 5 ticks (500ms).
			const tickTimer = setInterval(() => {
				if (abortPolling) return;
				tickCount++;
				widgetTui?.requestRender();

				if (tickCount % 5 === 0) {
					const tasks = readTasks();
					if (!tasks) return;
					const activeCount = Object.values(tasks).filter(
						(t) => t.status === "in_progress",
					).length;
					if (activeCount === 0) {
						clearInterval(tickTimer);
						ctx.ui.setWidget(widgetKey, undefined);
						deleteLoopActive(projectDir);
					}
				}
			}, 100);

			// Clean up timer when extension is shut down
			pi.on("session_shutdown", () => {
				abortPolling = true;
				clearInterval(tickTimer);
			});
		} else {
			// ── Sequential mode: per-task widget ──
			const currentTaskId = loopState.taskIds.find((id) => {
				const tasks = readTasks();
				return tasks?.[id]?.status === "in_progress";
			});

			if (currentTaskId) {
				const widgetKey = `ralpi-task-${currentTaskId}`;
				let widgetTui: { requestRender(): void } | null = null;

				const buildLines = (t: typeof ctx.ui.theme): string[] => {
					const tasks = readTasks();
					const info = tasks?.[currentTaskId];
					const title = titleMap.get(currentTaskId);
					const header = title ? `${currentTaskId} · ${title}` : currentTaskId;
					const lines: string[] = [];

					if (!info || info.status === "pending") {
						return [t.fg("dim", "(starting task...)")];
					}

					if (info.status === "completed") {
						lines.push(`${t.fg("success", "✓")} ${header}`);
					} else if (info.status === "failed") {
						lines.push(`${t.fg("error", "✗")} ${header}`);
					} else if (info.status === "in_progress") {
						const frame = t.fg(
							"accent",
							SPINNER_FRAMES[tickCount % SPINNER_FRAMES.length],
						);
						lines.push(`${frame} ${header}`);

						// Show recent tool calls
						const toolCalls = readRecentToolCalls(currentTaskId);
						if (toolCalls.length > 0) {
							const shown = toolCalls.slice(-MAX_COLLAPSED);
							const remaining = toolCalls.length - shown.length;
							if (remaining > 0) {
								lines.push(t.fg("dim", `  ├── …${remaining} earlier`));
							}
							for (let i = 0; i < shown.length; i++) {
								const tc = shown[i];
								const isLast = i === shown.length - 1;
								const branch = isLast ? "  └── " : "  ├── ";
								lines.push(
									`${branch}${t.fg("accent", `[${tc.name}]`)} ${tc.label}`,
								);
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

				const tickTimer = setInterval(() => {
					if (abortPolling) return;
					tickCount++;
					widgetTui?.requestRender();

					if (tickCount % 5 === 0) {
						const tasks = readTasks();
						if (!tasks) return;
						const status = tasks[currentTaskId]?.status;
						if (status !== "in_progress") {
							clearInterval(tickTimer);
							// Keep widget visible a moment, then clean up
							setTimeout(() => {
								ctx.ui.setWidget(widgetKey, undefined);
								deleteLoopActive(projectDir);
							}, 3000);
						}
					}
				}, 100);

				pi.on("session_shutdown", () => {
					abortPolling = true;
					clearInterval(tickTimer);
				});
			} else {
				// No task actively in progress — show a "resume" hint
				ctx.ui.notify(
					"No running task found. Use /ralpi resume to continue execution.",
					"warning",
				);
			}
		}
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
					pi.sendUserMessage("@task-manager");
					ctx.ui.notify("Opening Task Manager...", "info");
					return;
				case "resume":
					return handleResume(
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
	const mode = await selectExecutionMode(ctx, project, taskFile, config);
	const plan = buildPlanByMode(mode, project, completed);

	// Show dependency chain + execution plan before starting
	const depChain = formatDependencyChain(project);
	const formattedPlan = formatExecutionPlan(plan);
	if (mode === "parallel") {
		ctx.ui.notify(
			`${depChain}\n\n${formattedPlan}\n\nStarting parallel execution...`,
			"info",
		);
	} else {
		ctx.ui.notify(
			`${formattedPlan}\n\nStarting sequential execution...`,
			"info",
		);
	}

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
// (removed — use /ralpi plan to invoke @task-manager)

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
	const mode = await selectExecutionMode(ctx, project, taskFile, config);
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
// (removed — use /ralpi run to execute tasks)

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
