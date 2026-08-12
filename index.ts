import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
import { loadTaskManagerPrompt } from "./src/task-manager-prompt";
import { formatReflections } from "./src/reflection";
import { verdictGlyph, verdictSummary, formatFindings } from "./src/review";
import type { ReviewResult } from "./src/types";
import { executeBatch, type SendChatMessage, setStreamForwarder } from "./src/executor";
import {
	cleanupStaleWorktrees,
	finalizeCommittedWorktrees,
	abortMerge,
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
	ensureRalpiIgnored,
	listPRDsSorted,
	countPRDResumeStats,
	formatDuration,
} from "./src/utils";

type ExecutionMode = "parallel" | "sequential";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split a `--no-gitignore` opt-out out of the command args (in place). The
 * flag controls whether `/ralpi run|resume|reset` auto-adds `.ralpi/` to the
 * project's `.gitignore` — it defaults to on so ralpi's own artifacts never
 * end up staged in the user's repo.
 */
function stripNoGitignore(args: string[]): boolean {
	const i = args.indexOf("--no-gitignore");
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
}

/**
 * Ensure `.ralpi/` is gitignored in the project (unless opted out), and
 * notify once when the guard actually appended the entry.
 */
function ensureIgnoredNote(
	projectDir: string,
	ctx: ExtensionContext,
	noGitignore = false,
): void {
	if (noGitignore) return;
	if (ensureRalpiIgnored(projectDir)) {
		ctx.ui.notify(
			"· .ralpi/ added to .gitignore (opt out with --no-gitignore)",
			"info",
		);
	}
}

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
				"Save full review output to disk? (recommended — enables review feedback recovery when resuming interrupted loops)",
				[
					"Yes — write each review to .ralpi/reviews/<loop>/<task>.json",
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
 * to act on. Returns the selected PRD key and sourcePath.
 * If only one PRD exists, returns it without prompting.
 * Returns null if no PRDs exist.
 */
async function selectPRD(
	ctx: ExtensionContext,
	found: NonNullable<ReturnType<typeof findProgressFile>>,
	prompt: string,
): Promise<{ prdKey: string; sourcePath: string } | null> {
	const prds = listPRDsSorted(found.state);
	if (prds.length === 0) return null;
	if (prds.length === 1) {
		return { prdKey: prds[0].key, sourcePath: prds[0].prd.sourcePath };
	}

	// Multiple PRDs — show selection sorted by most recent first
	const options = prds.map((entry) => {
		// Total/completed must come from the parsed PRD file, not just the
		// progress map: the tracker only records TOUCHED tasks (started/
		// completed/failed), so never-started tasks would be silently missing
		// from a naive Object.keys() count and the totals would under-report.
		const { total, completed, failed } = countPRDResumeStats(
			entry.prd,
			entry.prd.sourcePath,
		);
		const relPath = path.relative(ctx.cwd, entry.prd.sourcePath);
		const updated = new Date(entry.prd.lastUpdatedAt).toLocaleString();
		return `${relPath} — ${completed}/${total} done${failed ? `, ${failed} failed` : ""} · ${updated}`;
	});

	const selected = await ctx.ui.select(prompt, options);
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
	// Refresh the model registry so the host reloads models.json before we
	// resolve the round-robin model pool. The registry snapshot is captured at
	// host startup and only reloaded here; a long-running host would otherwise
	// skip providers added to models.json after it booted (e.g. "strix").
	// Best-effort: a failed refresh shouldn't block execution — the pool just
	// resolves against the existing snapshot.
	try {
		await ctx.modelRegistry?.refresh();
	} catch (error) {
		ctx.ui.notify(
			`ralpi: model registry refresh failed — continuing with existing snapshot: ${
				error instanceof Error ? error.message : String(error)
			}`,
			"warning",
		);
	}

	// Write the loop-active marker so an interrupted loop can be resumed
	// non-interactively via /ralpi-resume: it snapshots the execution mode and
	// loop options (autoCommit/autoReview/saveReviews) that /ralpi-resume
	// would otherwise re-prompt for.
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

/** Pick the one useful argument from a tool-call's args (path/command/…). */
function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const obj = args as Record<string, unknown>;
	const pickKey = ["file_path", "path", "command", "pattern", "query", "url"].find(
		(k) => typeof obj[k] === "string",
	);
	if (pickKey) {
		const value = String(obj[pickKey]);
		return value.length > 120 ? `${value.slice(0, 117)}…` : value;
	}
	const json = JSON.stringify(obj);
	return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

/** Collapse a tool result down to a single short line. */
function summarizeToolResult(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return result;
	if (typeof result === "number" || typeof result === "boolean")
		return String(result);
	if (Array.isArray(result)) {
		return result
			.map((item) => {
				if (typeof item === "string") return item;
				if (
					item &&
					typeof item === "object" &&
					"text" in (item as Record<string, unknown>)
				)
					return String((item as { text?: unknown }).text ?? "");
				return JSON.stringify(item);
			})
			.join("\n");
	}
	if (typeof result !== "object") return "";
	const obj = result as Record<string, unknown>;
	if (Array.isArray(obj.content)) {
		const unwrapped = summarizeToolResult(obj.content);
		if (unwrapped) return unwrapped;
	}
	const preferKey = ["stdout", "output", "text", "content", "result"].find(
		(k) => typeof obj[k] === "string" && (obj[k] as string).length > 0,
	);
	if (preferKey) return obj[preferKey] as string;
	try {
		return JSON.stringify(obj);
	} catch {
		return "";
	}
}

/** Collapse whitespace and cap a line at `max` chars with an ellipsis. */
function compactLine(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1)}…`;
}

/** Extract joined text from an assistant message's content blocks. */
function extractAssistantTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((c) =>
			c && typeof c === "object" &&
				(c as { type?: string }).type === "text"
				? [(c as { text?: string }).text ?? ""]
				: [],
		)
		.join("");
}

/**
 * Build a stream-event forwarder that posts ralpi-stream messages (one chat
 * line per tool start/end and assistant turn) into the chat. Only used when
 * execution.chatStyle is "verbose".
 */
function makeStreamForwarder(pi: ExtensionAPI): (phase: string, event: import("@earendil-works/pi-coding-agent").AgentSessionEvent) => void {
	const send = (details: {
		kind: "tool-start" | "tool-end" | "tool-error" | "assistant";
		phase: string;
		toolName?: string;
		body?: string;
	}, fallback: string) => {
		pi.sendMessage({
			customType: "ralpi-stream",
			content: fallback,
			display: true,
			details,
		});
	};

	return (phase: string, event: import("@earendil-works/pi-coding-agent").AgentSessionEvent) => {
		switch (event.type) {
			case "tool_execution_start": {
				const body = summarizeArgs(event.args);
				send({ kind: "tool-start", phase, toolName: event.toolName, body }, `[${phase}] → ${event.toolName}${body ? `  ${body}` : ""}`);
				return;
			}
			case "tool_execution_end": {
				const body = compactLine(summarizeToolResult(event.result), 200);
				const kind = event.isError ? "tool-error" : "tool-end";
				const marker = event.isError ? "✗" : "←";
				send({ kind, phase, toolName: event.toolName, body }, `[${phase}] ${marker} ${event.toolName}${body ? `  ${body}` : ""}`);
				return;
			}
			case "message_end": {
				const message = event.message as { role?: string; content?: unknown };
				if (message.role !== "assistant") return;
				const text = extractAssistantTextFromContent(message.content).trim();
				if (!text) return;
				const head = compactLine(text, 240);
				send({ kind: "assistant", phase, body: head }, `[${phase}] ${head}`);
				return;
			}
		}
	};
}

// ─── Extension Entry ────────────────────────────────────────────────────────

export default function ralpiLoopExtension(pi: ExtensionAPI): void {
	// Wire the verbose stream forwarder — posts each tool event as its own
	// chat message via the ralpi-stream renderer. Enabled per-run by
	// `execution.chatStyle: verbose` in the config YAML.
	setStreamForwarder(makeStreamForwarder(pi));

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

	// ─── Verbose tool-event stream renderer ─────────────────────────────
	//
	// When execution.chatStyle is "verbose", each tool_execution_start/end and
	// assistant turn is posted as its own chat message — the piolium/pygienium
	// per-event stream. When "compact" (default), only the completion message
	// with its expandable tool-call tree shows (the existing ralpi-progress
	// renderer above).

	type StreamLineKind = "tool-start" | "tool-end" | "tool-error" | "assistant";

	interface StreamLineDetails {
		kind: StreamLineKind;
		phase: string;
		toolName?: string;
		body?: string;
	}

	pi.registerMessageRenderer<StreamLineDetails>(
		"ralpi-stream",
		(message, _options, theme) => {
			const details = message.details;
			if (!details || typeof details !== "object") {
				const fallback =
					typeof message.content === "string" ? message.content : "";
				return new Text(theme.fg("muted", fallback), 0, 0);
			}
			const { kind, phase, toolName, body } = details;
			const phaseTag = theme.fg("accent", `[${phase}]`);
			const indent = " ".repeat(phase.length + 3);
			let line: string;
			switch (kind) {
				case "tool-start": {
					const arrow = theme.fg("muted", "→");
					const name = theme.fg("toolTitle", theme.bold(toolName ?? ""));
					const args = body ? ` ${theme.fg("muted", body)}` : "";
					line = `${phaseTag} ${arrow} ${name}${args}`;
					break;
				}
				case "tool-end": {
					const arrow = theme.fg("success", "←");
					const result = body
						? ` ${theme.fg("dim", body)}`
						: ` ${theme.fg("dim", "(ok)")}`;
					line = `${indent}${arrow}${result}`;
					break;
				}
				case "tool-error": {
					const marker = theme.fg("error", "✗");
					const result = body
						? ` ${theme.fg("error", body)}`
						: ` ${theme.fg("error", "failed")}`;
					line = `${indent}${marker}${result}`;
					break;
				}
				case "assistant":
					line = `${phaseTag} ${theme.fg("muted", body ?? "")}`;
					break;
				default:
					line =
						typeof message.content === "string"
							? theme.fg("muted", message.content)
							: "";
			}
			return new Text(line, 0, 0);
		},
	);

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

			// Subcommands (run/plan/resume/reset) are handled by the dash commands
			// below — /ralpi only dispatches no-args → plan and path → run.
			ctx.ui.notify(
				`Unknown: ${parts[0]}. Use /ralpi-run, /ralpi-plan, /ralpi-resume, or /ralpi-reset`,
				"error",
			);
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

	const extensionDir = path.dirname(fileURLToPath(import.meta.url));

	pi.registerCommand("ralpi-plan", {
		description: "Open the Task Manager to plan a ralpi run",
		handler: async (args: string, ctx: ExtensionContext) => {
			// pi.sendUserMessage() sends with expandPromptTemplates: false, so it
			// would NOT expand `/task-manager` — and `@task-manager` is an
			// @-mention, not a template invocation. Load the bundled template,
			// strip frontmatter, substitute $@ args ourselves, and send the
			// expanded body directly.
			const body = loadTaskManagerPrompt(extensionDir, args ?? "");
			pi.sendUserMessage(body);
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
	const noGitignore = stripNoGitignore(args);
	const taskFile = resolveTaskArg(args[0] || "README.md", ctx.cwd);

	// A cancelled loop for this file is continued below AFTER re-prompting for
	// settings — /ralpi-run never silently resumes with the old loop's
	// settings (only /ralpi-resume does that). isResume below keeps the
	// interrupted task's worktree so it continues rather than restarts.
	const existingProgress = findProgressFile(ctx.cwd, taskFile);

	// Resolve the project root from any existing progress so running from a
	// subdirectory still targets the loop's project.
	const found = findProgressFile(ctx.cwd);

	const projectDir = found ? path.dirname(path.dirname(found.path)) : ctx.cwd;
	ensureIgnoredNote(projectDir, ctx, noGitignore);

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
		!!existingProgress, // preserve in-progress worktrees from a cancelled loop
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
 * build the remaining plan and execute it.
 *
 * `mode` and loop options (`autoCommit`/`autoReview`/`saveReviews`) may be
 * passed to skip interactive prompts — this is how /ralpi-resume resumes
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
	// with a committed worktree branch. Resuming without finalizing would
	// wastefully re-run finished work — or worse, strand the committed code in
	// `.ralpi/worktrees/` forever.
	//
	// finalizeCommittedWorktrees runs over EVERY non-failed task, not just
	// `in_progress` ones: a prior interrupted resume can reset tasks to
	// `pending` while their worktree branch still holds committed work that
	// was never merged. Only scanning in_progress tasks would silently leave
	// that code out of the workspace on every resume.
	//
	// `pending` tasks (never started) are excluded — they never had worktrees
	// created, so finalize always puts them in `rerun`, which is wasted work.
	// Failed tasks keep their worktrees for inspection/re-run and are also
	// deliberately excluded.
	const prdKeyForFinalize = progress.getKey();
	// Clear any half-done merge left in the main repo by an interrupted
	// conflict-resolution session — it would block every merge below
	// (`git merge` refuses while a merge is already in progress). No-op when
	// the repo isn't mid-merge.
	abortMerge(projectDir);
	const finalizeCandidateIds = Object.entries(
		progress.getState().tasks,
	).flatMap(([id, t]) =>
		t.status !== "failed" && t.status !== "pending" ? [id] : [],
	);
	if (finalizeCandidateIds.length > 0) {
		const fin = finalizeCommittedWorktrees(
			projectDir,
			config.paths.stateDir,
			prdKeyForFinalize,
			finalizeCandidateIds,
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
		// ── Handle conflicted tasks ──
		//
		// Tasks whose committed branch could not be auto-merged (git conflicts)
		// must be reset to `pending` so the DAG re-schedules them. The worktree
		// is preserved — the agent re-runs in-place in the existing worktree via
		// createWorktree's reuse logic. If the agent's re-run changes make the
		// merge succeed on the next attempt, the loop continues normally. If the
		// merge fails again, `executeBatch`'s batch-level conflict resolution
		// (`resolveConflictsSession`) handles the conflict markers properly.
		const conflictIds = Object.keys(fin.conflicts);
		if (conflictIds.length > 0) {
			const detail = conflictIds
				.map((id) => `${id}: ${fin.conflicts[id].slice(0, 3).join(", ")}`)
				.join("; ");
			// Batch-reset all conflicted tasks to pending, then save once.
			// Directly mutate the progress state (there's no markPending method
			// on ProgressTracker — markFailed would leave it as 'failed' which the
			// DAG excludes). The worktree is preserved so createWorktree reuses
			// it and the agent re-runs in-place.
			const tasks = progress.getState().tasks;
			for (const id of conflictIds) {
				if (tasks[id]) {
					tasks[id].status = "pending";
					delete tasks[id].startedAt;
					delete tasks[id].error;
				}
				try {
					updateTaskInFile(taskFile, id, "pending");
				} catch {
					// Best-effort
				}
			}
			progress.save();
			sendChatMessage?.(
				`⚠ ${conflictIds.join(
					", ",
				)} — merge conflict on resume-finalize; reset to pending for re-execution (${detail})`,
			);
			ctx.ui.notify(
				`Reset ${conflictIds.length} conflicted task(s) to pending for re-execution`,
				"info",
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
	const noGitignore = stripNoGitignore(args);
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
		const selected = await selectPRD(
			ctx,
			found,
			"Multiple loops found. Which to resume?",
		);
		if (!selected) {
			ctx.ui.notify("Resume cancelled.", "info");
			return;
		}
		taskFile = selected.sourcePath;
		prdKey = selected.prdKey;
	}

	// Reuse the loop snapshot (mode + autoCommit/autoReview/saveReviews)
	// persisted when the loop started, so an interrupted loop resumes
	// non-interactively. Only fall back to interactive prompts when no
	// snapshot is present.
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

	ensureIgnoredNote(projectDir, ctx, noGitignore);

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
	const noGitignore = stripNoGitignore(args);
	let sourcePath: string;
	let prdKey: string | undefined;
	let progress: ProgressTracker;

	if (args[0]) {
		const taskFile = resolveTaskArg(args[0], ctx.cwd);
		const found = findProgressFile(ctx.cwd, taskFile);
		const projectDir = found ? path.dirname(path.dirname(found.path)) : ctx.cwd;
		ensureIgnoredNote(projectDir, ctx, noGitignore);
		sourcePath = taskFile;
		prdKey = found?.prdKey;
		progress = new ProgressTracker(projectDir, taskFile, prdKey);
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

		ensureIgnoredNote(projectDir, ctx, noGitignore);

		// Multiple loops may have progress — let the user select which one to
		// reset (sorted by most recent first), same as resume.
		const selected = await selectPRD(
			ctx,
			found,
			"Multiple loops found. Which to reset?",
		);
		if (!selected) {
			ctx.ui.notify("Reset cancelled.", "info");
			return;
		}
		sourcePath = selected.sourcePath;
		prdKey = selected.prdKey;
		progress = new ProgressTracker(projectDir, sourcePath, prdKey);
	}

	// Ask whether to also clear the progress markers (checkboxes/status) in the
	// source PRD/README file itself, not just .ralpi/progress.json.
	const taskIds = Object.keys(progress.getState().tasks);
	if (taskIds.length > 0) {
		const choice = await ctx.ui.select(
			`Also reset progress markers in the source file (${path.basename(
				sourcePath,
			)})?`,
			[
				"Yes — clear checkboxes/status markers in the source PRD/README",
				"No — only reset .ralpi/progress.json",
			],
		);
		if (choice === undefined) {
			ctx.ui.notify("Reset cancelled.", "info");
			return;
		}
		if (choice.startsWith("Yes")) {
			progress.reset();
			for (const id of taskIds) {
				updateTaskInFile(sourcePath, id, "pending");
			}
			ctx.ui.notify(
				`Progress reset — cleared ${taskIds.length} task marker(s) in ${path.basename(sourcePath)}.`,
				"info",
			);
			return;
		}
	}

	progress.reset();
	ctx.ui.notify("Progress reset. All task statuses cleared.", "info");
}
