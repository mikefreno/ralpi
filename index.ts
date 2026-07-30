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
import { verdictGlyph, verdictSummary, formatFindings } from "./src/review";
import type { ReviewResult } from "./src/types";
import { executeBatch, type SendChatMessage } from "./src/executor";
import {
	cleanupStaleWorktrees,
	finalizeCommittedWorktrees,
} from "./src/worktree";
import {
	loadConfig,
	resolveTaskArg,
	formatProgressStatus,
	findProgressFile,
	writeLoopActive,
	deleteLoopActive,
	readLoopActive,
	findRalpiDir,
	listPRDsSorted,
	formatDuration,
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

/**
 * Prompt the user to select auto-review and auto-commit options for this loop.
 * Reviews are asked about FIRST. When autoReview is on, commit is always
 * mandated (it happens before review) — so autoCommit is forced true and not
 * asked about. When autoReview is off, autoCommit is asked as a stand-alone
 * toggle. Fields explicitly set in the config YAML are skipped (no prompt).
 * Returns the selected options (or config defaults if cancelled).
 */
async function selectLoopOptions(
	ctx: ExtensionContext,
	config: import("./src/types").RalpiConfig,
): Promise<{ autoCommit: boolean; autoReview: boolean; saveReviews: boolean }> {
	const explicit = config.execution.explicitKeys;

	// ── 1. Auto-review (asked FIRST) ──
	// When enabled, a commit is mandated before review (the task agent's
	// changes are committed, then the complete diff is reviewed). On 'fail'
	// the task is re-executed with review feedback (looping until pass or
	// maxReviewRetries exhausted). On pass the worktree merges.
	let autoReview: boolean;
	if (explicit?.has("autoReview")) {
		autoReview = config.execution.autoReview;
	} else {
		const reviewChoice = await ctx.ui.select("Auto-review after each task?", [
			"Yes — review the task commit and loop on failures (re-execute until pass)",
			"No — skip review",
		]);
		autoReview = reviewChoice
			? reviewChoice.startsWith("Yes")
			: config.execution.autoReview;
	}

	// ── 2. Save full review output to disk (only when review is enabled) ──
	let saveReviews = false;
	if (autoReview) {
		if (explicit?.has("saveReviews")) {
			saveReviews = config.execution.saveReviews;
		} else {
			const saveChoice = await ctx.ui.select(
				"Save full review output to disk?",
				[
					"Yes — write each review to .ralpi/reviews/<loop>/<task>.md",
					"No — keep reviews in-chat only",
				],
			);
			saveReviews = saveChoice
				? saveChoice.startsWith("Yes")
				: config.execution.saveReviews;
		}
	}

	// ── 3. Auto-commit ──
	// When autoReview is on, commit is always mandated (it happens before the
	// review). autoCommit is forced true and not asked about. When review is
	// disabled, autoCommit is asked as a stand-alone "commit per task" toggle.
	let autoCommit: boolean;
	if (autoReview) {
		autoCommit = true; // mandated by the review-gated flow
	} else if (explicit?.has("autoCommit")) {
		autoCommit = config.execution.autoCommit;
	} else {
		const commitChoice = await ctx.ui.select("Auto-commit after each task?", [
			"Yes — stage and commit changes automatically",
			"No — skip auto-commit",
		]);
		autoCommit = commitChoice
			? commitChoice.startsWith("Yes")
			: config.execution.autoCommit;
	}

	return { autoCommit, autoReview, saveReviews };
}

/**
 * When multiple PRD loops have progress, prompt the user to select which one
 * to resume. Returns the selected PRD key and sourcePath.
 * If only one PRD exists, returns it without prompting.
 * Returns null if no PRDs exist.
 */
async function selectPRDToResume(
	ctx: ExtensionContext,
	found: NonNullable<ReturnType<typeof findProgressFile>>,
): Promise<{ prdKey: string; sourcePath: string } | null> {
	const prds = listPRDsSorted(found.state);
	if (prds.length === 0) return null;
	if (prds.length === 1) {
		return { prdKey: prds[0].key, sourcePath: prds[0].prd.sourcePath };
	}

	// Multiple PRDs — show selection sorted by most recent first
	const options = prds.map((entry) => {
		const tasks = entry.prd.tasks;
		const total = Object.keys(tasks).length;
		const completed = Object.values(tasks).filter(
			(t) => t.status === "completed",
		).length;
		const failed = Object.values(tasks).filter(
			(t) => t.status === "failed",
		).length;
		const relPath = path.relative(ctx.cwd, entry.prd.sourcePath);
		const updated = new Date(entry.prd.lastUpdatedAt).toLocaleString();
		return `${relPath} — ${completed}/${total} done${failed ? `, ${failed} failed` : ""} · ${updated}`;
	});

	const selected = await ctx.ui.select(
		"Multiple loops found. Which to resume?",
		options,
	);
	if (!selected) return null;

	const idx = options.indexOf(selected);
	if (idx === -1) return null;
	return {
		prdKey: prds[idx].key,
		sourcePath: prds[idx].prd.sourcePath,
	};
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
	isResume?: boolean,
): Promise<void> {
	// Write loop-active marker so a session reload can detect an interrupted
	// loop and resume it (in-process agent sessions die on reload — the marker
	// + progress.json in_progress tasks are the signal to re-run them).
	if (projectDir) {
		const allTaskIds = plan.batches.flatMap((b) => b.tasks.map((t) => t.id));
		writeLoopActive(projectDir, {
			taskFile,
			mode,
			startedAt: new Date().toISOString(),
			taskIds: allTaskIds,
			prdKey: progress.getKey(),
			autoCommit: config.execution.autoCommit,
			autoReview: config.execution.autoReview,
			saveReviews: config.execution.saveReviews,
		});

		// Clean up stale worktrees from interrupted runs before starting.
		// On resume this MUST be skipped: an interrupted in-progress task's
		// worktree still carries its committed branch, which createWorktree()
		// reuses to continue the task rather than restarting from scratch.
		// The stale-worktree sweep only runs for fresh loops so concurrent
		// loops (other PRDs) are still scoped out via the prdKey filter above.
		if (!isResume && config.execution.worktrees !== "never" && projectDir) {
			const removed = cleanupStaleWorktrees(
				projectDir,
				config.paths.stateDir,
				progress.getKey(),
			);
			if (removed.length > 0) {
				ctx.ui.notify(
					`Cleaned up ${removed.length} stale worktree(s) from previous run.`,
					"info",
				);
			}
		}
	}

	// Track failed task IDs across batches to block downstream tasks
	const failedTaskIds = new Set(progress.getFailedTaskIds());

	// Loop-level execution timeout: stop starting new batches once elapsed.
	// In-progress tasks finish naturally; we just skip remaining batches.
	const loopStart = Date.now();
	const loopTimeoutMs = config.execution.loopTimeoutMs;
	let loopTimedOut = false;

	try {
		for (const batch of plan.batches) {
			// Check loop timeout before starting a new batch
			if (loopTimeoutMs > 0 && Date.now() - loopStart > loopTimeoutMs) {
				loopTimedOut = true;
				break;
			}

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
		if (loopTimedOut) {
			const elapsed = formatDuration(Date.now() - loopStart);
			ctx.ui.notify(
				`Loop execution timeout reached (${elapsed}). Remaining tasks skipped. Use /ralpi resume to continue.`,
				"warning",
			);
		}
	}
}

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/**
 * Build a sendProgress closure that posts ralpi progress messages into the
 * chat history for the expandable tool-call-tree renderer.
 *
 * Used by every registered command so they share one rendering path.
 */
function makeSendProgress(pi: ExtensionAPI): SendChatMessage {
	return (content, meta) => {
		pi.sendMessage({
			customType: "ralpi-progress",
			content,
			display: true,
			details: {
				phase: "progress",
				toolCalls: meta?.toolCalls,
				reviewText: meta?.reviewText,
				reviewPath: meta?.reviewPath,
				reviewResult: meta?.reviewResult,
			},
		});
	};
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
						reviewText?: string;
						reviewPath?: string;
						reviewResult?: ReviewResult;
				  }
				| undefined;

			const MAX_COLLAPSED = 3;
			const lines: string[] = [];

			// Header line — e.g. "✓ 05 · billing-subscriptions-trials (2m 14s)"
			lines.push(String(message.content));

			// Structured review: when we have a ReviewResult, render verdict +
			// findings tree. In expanded mode show findings detail; collapsed
			// shows the verdict summary + a hint to expand.
			const hasReview = !!details?.reviewText || !!details?.reviewResult;
			if (details?.reviewResult) {
				const rv = details.reviewResult;
				const glyph = verdictGlyph(rv.verdict);
				const summary = verdictSummary(rv);
				if (expanded) {
					// Show verdict, summary, then findings tree, then raw text.
					lines.push(`  ${glyph} VERDICT: ${rv.verdict.toUpperCase()}`);
					lines.push(`  ${rv.summary}`);
					if (rv.findings.length > 0) {
						lines.push(`  ${formatFindings(rv)}`);
					}
					if (details.reviewText) {
						const body = details.reviewText.split("\n");
						for (const line of body) {
							lines.push(`  ${line}`);
						}
					}
				} else {
					const hint = details.reviewPath
						? `press Ctrl+O for full review · saved to ${details.reviewPath}`
						: "press Ctrl+O for full review";
					lines.push(theme.fg("dim", `  ├── ${glyph} ${summary} · ${hint}`));
				}
			} else if (hasReview && expanded && details!.reviewText) {
				const body = details!.reviewText.split("\n");
				for (const line of body) {
					lines.push(`  ${line}`);
				}
			} else if (hasReview && !expanded) {
				const hint = details?.reviewPath
					? `press Ctrl+O for full review · saved to ${details.reviewPath}`
					: "press Ctrl+O for full review";
				lines.push(theme.fg("dim", `  ├── ${hint}`));
			}

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

	// ─── Reload detection: resume interrupted loops when session reloads ──
	//
	// ralpi runs task agent sessions in-process (createAgentSession), so they
	// do NOT survive a /reload. When the new session starts, this handler
	// reads the persisted loop-active marker + progress.json: if any task is
	// still `in_progress`, the loop was interrupted mid-task and we resume it
	// (resetting those tasks to pending so the DAG re-schedules them), using
	// the mode + loop options snapshotted in loop-active.json so the resume is
	// non-interactive.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "reload") return;

		// Find the ralpi project directory
		const projectDir = findRalpiDir(ctx.cwd);
		if (!projectDir) return;

		// Check if a task execution loop was active before the reload
		const loopState = readLoopActive(projectDir);
		if (!loopState) return;

		// Load progress state
		const progressPath = path.join(projectDir, ".ralpi", "progress.json");

		/** Re-read progress from disk. */
		const readTasks = (): Record<string, { status: string }> | null => {
			try {
				const raw = fs.readFileSync(progressPath, "utf-8");
				const parsed = JSON.parse(raw) as Record<string, any>;
				return parsed.prds?.[loopState.prdKey]?.tasks ?? parsed.tasks ?? null;
			} catch {
				return null;
			}
		};

		// ralpi agent sessions run in-process (createAgentSession), so they do
		// NOT survive a session reload. Any task left `in_progress` is therefore
		// stalled — its agent died with the previous session. Detect that state
		// and actively resume the loop instead of passively polling (which would
		// spin forever waiting for a dead task to complete).
		const initialTasks = readTasks();
		if (initialTasks) {
			const inProgressIds = Object.entries(initialTasks).flatMap(([id, t]) =>
				t.status === "in_progress" ? [id] : [],
			);

			if (inProgressIds.length === 0) {
				// Nothing was mid-flight — loop either finished cleanly between
				// the reload landing and this handler running, or was stopped
				// between tasks. Clean up the stale marker and bail.
				ctx.ui.notify(
					"ralpi loop has no in-progress task to resume — marking complete.",
					"info",
				);
				deleteLoopActive(projectDir);
				return;
			}

			const taskCount = loopState.taskIds.length;
			ctx.ui.notify(
				`ralpi loop was interrupted by reload with ${inProgressIds.length} in-progress task(s). ` +
					`Resuming execution (${taskCount} tasks, ${loopState.mode} mode)...`,
				"info",
			);

			// Build the sendProgress wrapper so resumed task messages render the
			// same expandable tool-call tree as an interactive run.
			const sendProgress: SendChatMessage = (
				content: string,
				meta?: {
					toolCalls?: Array<{ name: string; label: string }>;
					reviewText?: string;
					reviewPath?: string;
					reviewResult?: ReviewResult;
				},
			) => {
				pi.sendMessage({
					customType: "ralpi-progress",
					content,
					display: true,
					details: {
						phase: "progress",
						toolCalls: meta?.toolCalls,
						reviewText: meta?.reviewText,
						reviewPath: meta?.reviewPath,
						reviewResult: meta?.reviewResult,
					},
				});
			};

			// Load config from the project directory so model + thinking level
			// resolve the same way the interactive command handler does.
			const config = loadConfig(projectDir);

			try {
				await resumeLoop(
					ctx,
					loopState.taskFile,
					projectDir,
					loopState.prdKey,
					sendProgress,
					config.model ?? ctx.model,
					pi.getThinkingLevel(),
					{
						mode: loopState.mode,
						autoCommit: loopState.autoCommit ?? config.execution.autoCommit,
						autoReview: loopState.autoReview ?? config.execution.autoReview,
						saveReviews: loopState.saveReviews ?? config.execution.saveReviews,
						skipFinalStatus: false,
					},
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`ralpi auto-resume failed: ${msg}`, "error");
				// Leave loop-active.json in place so the user can retry via
				// /ralpi resume after addressing the underlying error.
			}
			return;
		}
	});

	pi.registerCommand("ralpi", {
		description:
			"Execute tasks from a task file using DAG-based dependency resolution",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sendProgress = makeSendProgress(pi);

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
					const found = findProgressFile(ctx.cwd);
					if (found) {
						ctx.ui.notify(
							`Unknown command: ${command}\n\nFound existing progress in ${
								found.path
							}\nUse /ralpi-resume to continue.\n\nAvailable: ${COMMANDS.join(
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

	// ─── Dedicated subcommands (dash namespace) ──────────────────────────
	//
	// Each subcommand is registered as its own top-level Pi command so the
	// slash-menu autocompletes it directly (`/ralpi-run`, `/ralpi-resume`, …)
	// instead of requiring the user to type `/ralpi <subcommand>` and rely on
	// raw-string dispatch. `/ralpi` above remains as a back-compat dispatcher.
	pi.registerCommand("ralpi-run", {
		description: "Run tasks from a task file (DAG-based execution)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			return handleRun(
				ctx,
				parts,
				makeSendProgress(pi),
				ctx.model,
				pi.getThinkingLevel(),
			);
		},
	});

	pi.registerCommand("ralpi-plan", {
		description: "Open the Task Manager to plan a ralpi run",
		handler: async (args: string, ctx: ExtensionContext) => {
			const prompt = (args || "").trim();
			const message = prompt ? `@task-manager\n\n${prompt}` : "@task-manager";
			pi.sendUserMessage(message);
			ctx.ui.notify("Opening Task Manager...", "info");
		},
	});

	pi.registerCommand("ralpi-resume", {
		description: "Resume an interrupted ralpi loop from persisted progress",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			return handleResume(
				ctx,
				parts,
				makeSendProgress(pi),
				ctx.model,
				pi.getThinkingLevel(),
			);
		},
	});

	pi.registerCommand("ralpi-reset", {
		description: "Reset ralpi progress for a task file",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			return handleReset(ctx, parts);
		},
	});
}

// ─── /ralpi plan ─────────────────────────────────────────────────────────────

async function handlePlan(
	ctx: ExtensionContext,
	args: string[],
): Promise<void> {
	const taskFile = resolveTaskArg(args[0] || "README.md", ctx.cwd);
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
	const taskFile = resolveTaskArg(args[0] || "README.md", ctx.cwd);

	// If targeting a specific task file and there's existing progress for it,
	// auto-resume instead of starting fresh
	const existingProgress = findProgressFile(ctx.cwd, taskFile);
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
	const found = findProgressFile(ctx.cwd);
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

	const projectDir = found ? path.dirname(path.dirname(found.path)) : ctx.cwd;

	const project = parseTaskFile(taskFile);
	const config = loadConfig(projectDir);
	config.model = parentModel ?? ctx.model;
	config.thinkingLevel = parentThinkingLevel;
	const progress = new ProgressTracker(projectDir, taskFile);

	const completed = buildCompletedSet(progress, project);
	const mode = await selectExecutionMode(ctx, project, taskFile, config);
	const { autoCommit, autoReview, saveReviews } = await selectLoopOptions(
		ctx,
		config,
	);
	config.execution.autoCommit = autoCommit;
	config.execution.autoReview = autoReview;
	config.execution.saveReviews = saveReviews;
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

/**
 * Resume core: given a resolved task file, project dir, and PRD key,
 * build the remaining plan and execute it. Used by both the explicit
 * `/ralpi resume` command and the auto-resume on session reload.
 *
 * `mode` and loop options (`autoCommit`/`autoReview`/`saveReviews`) may be
 * passed to skip interactive prompts — this is how a reload resumes
 * non-interactively using the snapshot stored in loop-active.json.
 * When omitted, the user is prompted as usual.
 */
async function resumeLoop(
	ctx: ExtensionContext,
	taskFile: string,
	projectDir: string,
	prdKey: string | undefined,
	sendChatMessage: SendChatMessage | undefined,
	parentModel: unknown,
	parentThinkingLevel: unknown,
	options?: {
		mode?: ExecutionMode;
		autoCommit?: boolean;
		autoReview?: boolean;
		saveReviews?: boolean;
		skipFinalStatus?: boolean;
	},
): Promise<void> {
	const project = parseTaskFile(taskFile);
	if (!Array.isArray(project.tasks)) {
		throw new Error(
			`Parsed project from ${taskFile} has invalid tasks: expected array, got ${typeof project.tasks}`,
		);
	}
	const config = loadConfig(projectDir);
	config.model = parentModel ?? ctx.model;
	config.thinkingLevel = parentThinkingLevel;
	const progress = new ProgressTracker(projectDir, taskFile, prdKey);

	progress.setPaused(false);

	// ── Self-heal: finalize tasks that finished but were never merged ──
	//
	// A review-gated task whose agent committed + reviewed successfully still
	// needs a final merge into main + worktree removal to be "done". If the
	// loop was interrupted between that commit and the merge, the task is left
	// `in_progress` with a clean, committed worktree branch. Resuming without
	// finalizing would wastefully re-run finished work.
	//
	// finalizeCommittedWorktrees merges those branches into main now; the
	// rest (dirty trees, nothing committed, conflicts) are left in_progress
	// and reset to pending below for a real re-run.
	const prdKeyForFinalize = progress.getKey();
	const inProgressIds = Object.entries(progress.getState().tasks)
		.filter(([, t]) => t.status === "in_progress")
		.map(([id]) => id);
	if (inProgressIds.length > 0) {
		const fin = finalizeCommittedWorktrees(
			projectDir,
			config.paths.stateDir,
			prdKeyForFinalize,
			inProgressIds,
		);
		for (const id of fin.finalized) {
			progress.markCompleted(id, 0);
			try {
				updateTaskInFile(taskFile, id, "completed");
			} catch {
				// Best-effort — progress.json is the source of truth for scheduling.
			}
			sendChatMessage?.(
				`✓ ${id} — finalized on resume (committed branch merged into main)`,
			);
		}
		const conflictIds = Object.keys(fin.conflicts);
		if (conflictIds.length > 0) {
			const detail = conflictIds
				.map((id) => `${id}: ${fin.conflicts[id].slice(0, 3).join(", ")}`)
				.join("; ");
			sendChatMessage?.(
				`⚠ ${conflictIds.join(", ")} — merge conflict on resume-finalize; re-running (${detail})`,
			);
		}
	}

	// Any task still `in_progress` (those NOT finalized above) died with the
	// previous session (ralpi runs agents in-process). Reset them to `pending`
	// so the DAG re-schedules them cleanly. Without this they'd still be
	// re-run (they're not in the completed set), but the progress.json would
	// carry a stale in_progress state during the rebuild window.
	const resetIds = progress.resetInProgressToPending();
	if (resetIds.length > 0) {
		// Keep the source-file checkboxes in sync so a later parse sees these
		// tasks as `pending` rather than `in_progress`.
		for (const id of resetIds) {
			try {
				updateTaskInFile(taskFile, id, "pending");
			} catch {
				// Best-effort — progress.json is the source of truth for scheduling.
			}
		}
		ctx.ui.notify(
			`Reset stalled in-progress task(s) to pending: ${resetIds.join(", ")}`,
			"info",
		);
	}

	const completed = buildCompletedSet(progress, project);
	const mode =
		options?.mode ??
		(await selectExecutionMode(ctx, project, taskFile, config));

	let autoCommit: boolean;
	let autoReview: boolean;
	let saveReviews: boolean;
	if (
		options?.autoCommit !== undefined &&
		options?.autoReview !== undefined &&
		options?.saveReviews !== undefined
	) {
		autoCommit = options.autoCommit;
		autoReview = options.autoReview;
		saveReviews = options.saveReviews;
	} else {
		const opt = await selectLoopOptions(ctx, config);
		autoCommit = opt.autoCommit;
		autoReview = opt.autoReview;
		saveReviews = opt.saveReviews;
	}
	config.execution.autoCommit = autoCommit;
	config.execution.autoReview = autoReview;
	config.execution.saveReviews = saveReviews;
	const plan = buildPlanByMode(mode, project, completed);

	// Print remaining batches before executing
	const formattedPlan = formatExecutionPlan(plan);
	if (mode === "parallel") {
		ctx.ui.notify(`${formattedPlan}\n\nResuming parallel execution...`, "info");
	} else {
		ctx.ui.notify(
			`${formattedPlan}\n\nResuming sequential execution...`,
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
		true, // isResume — preserve in-progress worktrees, continue them
	);

	if (!options?.skipFinalStatus) {
		ctx.ui.notify(formatProgressStatus(progress.getState()), "info");
	}
}

async function handleResume(
	ctx: ExtensionContext,
	args: string[],
	sendChatMessage?: SendChatMessage,
	parentModel?: unknown,
	parentThinkingLevel?: unknown,
): Promise<void> {
	let taskFile: string;
	let projectDir: string;
	let prdKey: string | undefined;

	if (args[0]) {
		taskFile = resolveTaskArg(args[0], ctx.cwd);
		const found = findProgressFile(ctx.cwd, taskFile);
		if (!found) {
			ctx.ui.notify(
				`No existing progress for ${args[0]}. Start with /ralpi run ${args[0]}`,
				"warning",
			);
			return;
		}
		projectDir = path.dirname(path.dirname(found.path));
		prdKey = found.prdKey;
	} else {
		const found = findProgressFile(ctx.cwd);
		if (!found) {
			ctx.ui.notify(
				"No .ralpi/progress.json found. Start with /ralpi run [task-file]",
				"warning",
			);
			return;
		}
		projectDir = path.dirname(path.dirname(found.path));

		// When no specific task file is given, let the user select which loop
		// to resume from multiple PRDs (sorted by most recent first).
		const selected = await selectPRDToResume(ctx, found);
		if (!selected) {
			ctx.ui.notify("Resume cancelled.", "info");
			return;
		}
		taskFile = selected.sourcePath;
		prdKey = selected.prdKey;
	}

	// Reuse the loop snapshot (mode + autoCommit/autoReview/saveReviews)
	// persisted when the loop started, so an interrupted loop resumes
	// non-interactively — matching the auto-resume-on-reload path. Only fall
	// back to interactive prompts when no snapshot is present.
	const snapshot = readLoopActive(projectDir);
	const loopOpts = (() => {
		if (
			snapshot &&
			snapshot.prdKey === prdKey &&
			snapshot.mode &&
			snapshot.autoCommit !== undefined &&
			snapshot.autoReview !== undefined &&
			snapshot.saveReviews !== undefined
		) {
			return {
				mode: snapshot.mode as ExecutionMode,
				autoCommit: snapshot.autoCommit,
				autoReview: snapshot.autoReview,
				saveReviews: snapshot.saveReviews,
			};
		}
		return undefined;
	})();

	await resumeLoop(
		ctx,
		taskFile,
		projectDir,
		prdKey,
		sendChatMessage,
		parentModel,
		parentThinkingLevel,
		loopOpts,
	);
}

// ─── /ralpi next ─────────────────────────────────────────────────────────────
// (removed — use /ralpi run to execute tasks)

// ─── /ralpi reset ────────────────────────────────────────────────────────────

async function handleReset(
	ctx: ExtensionContext,
	args: string[],
): Promise<void> {
	if (args[0]) {
		const taskFile = resolveTaskArg(args[0], ctx.cwd);
		const found = findProgressFile(ctx.cwd, taskFile);
		const projectDir = found ? path.dirname(path.dirname(found.path)) : ctx.cwd;
		const progress = new ProgressTracker(projectDir, taskFile, found?.prdKey);
		progress.reset();
	} else {
		const found = findProgressFile(ctx.cwd);
		if (!found) {
			ctx.ui.notify(
				"No .ralpi/progress.json found. Start with /ralpi run [task-file]",
				"warning",
			);
			return;
		}
		const projectDir = path.dirname(path.dirname(found.path));
		// Use the most recently updated PRD (first in sorted order)
		const prds = listPRDsSorted(found.state);
		const sourcePath =
			prds.length > 0 ? prds[0].prd.sourcePath : found.state.sourcePath;
		const progress = new ProgressTracker(projectDir, sourcePath);
		progress.reset();
	}

	ctx.ui.notify("Progress reset. All task statuses cleared.", "info");
}
