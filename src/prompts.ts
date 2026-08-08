import type { Task, Project, Reflection, ReviewResult } from "./types";
import { readTaskSpec } from "./parser";
import {
	parseDiff,
	filterNoise,
	type DiffSummary,
	type DiffOptions,
} from "./diff";

/** Maximum bytes of an inlined review diff before we stop inlining it and
 *  instead list the changed files + tell the model to `read` them.
 *  Diffs larger than this are never byte-truncated into a review prompt —
 *  truncation loses the middle of a large diff, so the file-list + read
 *  instruction is strictly better.
 *
 *  ~50 KB ≈ 12.5K tokens — comfortably fits even on models with a 128K
 *  context window once system-prompt overhead is accounted for. */
export const MAX_DIFF_BYTES = 50_000;

/** Max included files before an oversized diff is replaced by a read
 *  instruction rather than inlined. */
const MAX_REVIEW_FILES = 20;

/** Optional knobs for the review prompt builders. */
export interface ReviewPromptOptions {
	/** Extra context injected into the prompt (config.prompts.projectContext). */
	projectContext?: string;
	/** Per-review custom focus/instructions (config.prompts.reviewFocus). */
	focus?: string;
	/** Noise-filter overrides (config.review.*). */
	diffOptions?: DiffOptions;
}

// ─── Task Prompt ─────────────────────────────────────────────────────────────

/**
 * Build the prompt for a single task execution.
 * Injects task details, dependency reflections, and project context.
 */
export function buildTaskPrompt(
	task: Task,
	project: Project,
	depReflections: Reflection[],
	projectContext?: string,
	/** Review feedback from a rejected review — injected when re-executing
	 *  a task in review-gated mode so the agent knows what to fix. */
	reviewFeedback?: ReviewResult,
): string {
	const parts: string[] = [];

	// ── Header ──

	parts.push(`# Task ${task.id}: ${task.title}`);
	parts.push("");

	// ── Project Objective ──

	if (project.objective) {
		parts.push("## Project Objective");
		parts.push(project.objective);
		parts.push("");
	}

	// ── Exit Criteria ──

	if (project.exitCriteria && project.exitCriteria.length > 0) {
		parts.push("## Exit Criteria");
		for (const criterion of project.exitCriteria) {
			parts.push(`- ${criterion}`);
		}
		parts.push("");
	}

	// ── Task Description ──

	if (task.description) {
		parts.push("## Description");
		parts.push(task.description);
		parts.push("");
	}

	// ── Task Specification ──

	if (task.file) {
		const spec = readTaskSpec(project.sourceDir, task.file);
		if (spec) {
			parts.push("## Task Specification");
			parts.push(`Full details from \`${task.file}\`:`);
			parts.push("");
			parts.push(spec);
			parts.push("");
		}
	}

	// ── Dependencies ──

	if (task.dependencies && task.dependencies.length > 0) {
		parts.push("## Dependencies");
		parts.push(`This task depends on: ${task.dependencies.join(", ")}`);
		parts.push("");
	}

	// ── Dependency Reflections ──

	if (depReflections.length > 0) {
		parts.push("## Completed Dependency Reflections");
		parts.push(
			"The following tasks have been completed. Use their reflections for context:",
		);
		parts.push("");

		for (const ref of depReflections) {
			parts.push(`### Task ${ref.taskId}: ${ref.title}`);
			parts.push(`**Summary:** ${ref.summary}`);

			if (ref.keyLearnings && ref.keyLearnings.length > 0) {
				parts.push("**Key Learnings:**");
				for (const learning of ref.keyLearnings) {
					parts.push(`- ${learning}`);
				}
			}

			if (ref.filesChanged && ref.filesChanged.length > 0) {
				parts.push(`**Files Changed:** ${ref.filesChanged.join(", ")}`);
			}

			if (ref.blockers && ref.blockers.length > 0) {
				parts.push(`**Known Issues:** ${ref.blockers.join("; ")}`);
			}

			parts.push("");
		}
	}

	// ── Project Context ──

	if (projectContext) {
		parts.push("## Additional Context");
		parts.push(projectContext);
		parts.push("");
	}

	// ── Previous Review Feedback (re-execution only) ──

	if (reviewFeedback) {
		parts.push("## Previous Review Feedback — FIX REQUIRED");
		parts.push(
			"A review agent examined your previous attempt and rejected it.",
		);
		parts.push(`Verdict: **${reviewFeedback.verdict.toUpperCase()}**`);
		parts.push(`Summary: ${reviewFeedback.summary}`);
		parts.push("");
		if (reviewFeedback.findings.length > 0) {
			parts.push("You MUST address these findings:");
			for (const finding of reviewFeedback.findings) {
				const loc = finding.file
					? finding.line
						? ` (${finding.file}:${finding.line})`
						: ` (${finding.file})`
					: "";
				parts.push(`- [${finding.severity}]${loc} ${finding.message}`);
			}
			parts.push("");
		}
		parts.push("Fix every issue above. Do not re-introduce the same problems.");
		parts.push("");
	}

	// ── Reflection Instructions ──

	parts.push("## REFLECTION (REQUIRED)");
	parts.push(
		"When the task is COMPLETE, end your response with a reflection section.",
	);
	parts.push("Use EXACTLY this format at the END of your response:");
	parts.push("");
	parts.push("```");
	parts.push("## REFLECTION");
	parts.push("SUMMARY: [1-2 sentence description of what was accomplished]");
	parts.push("FILES: [comma-separated list of files created or modified]");
	parts.push("LEARNINGS:");
	parts.push("- [key decision, pattern, or architectural choice]");
	parts.push("- [important API or interface details]");
	parts.push("- [anything downstream tasks need to know]");
	parts.push("BLOCKERS: [any unresolved issues, or 'none']");
	parts.push("```");
	parts.push("");
	parts.push(
		"Also use the `memory` tool to save important learnings that will",
	);
	parts.push(
		"be useful across future sessions (architecture decisions, API patterns, etc.)",
	);

	return parts.join("\n");
}

// ─── Review Prompt ───────────────────────────────────────────────────────────

/**
 * Build the prompt for the auto-review agent.
 * Includes the task description and the latest commit diff so the reviewer
 * can assess whether the commit fulfills the task requirements.
 */
export function buildReviewPrompt(
	task: Task,
	project: Project,
	commitHash: string,
	commitSubject: string,
	commitDiff: string,
	opts: ReviewPromptOptions = {},
): string {
	const parts: string[] = [];

	parts.push(`# Code Review: Task ${task.id}: ${task.title}`);
	parts.push("");

	// ── Task Description ──

	parts.push("## Task Description");
	if (task.description) {
		parts.push(task.description);
	} else {
		parts.push(task.title);
	}
	parts.push("");

	// ── Task Specification ──

	if (task.file) {
		const spec = readTaskSpec(project.sourceDir, task.file);
		if (spec) {
			parts.push("## Task Specification");
			parts.push(`Full details from \`${task.file}\`:`);
			parts.push("");
			parts.push(spec);
			parts.push("");
		}
	}

	// ── Commit Under Review ──

	parts.push("## Commit Under Review");
	parts.push(`Commit: ${commitHash} — ${commitSubject}`);
	parts.push("");

	// ── Changed-Files Summary + Exclusions (noise-filtered scope) ──

	const summary = parseDiff(commitDiff, opts.diffOptions);
	const filtered = filterNoise(commitDiff, opts.diffOptions);
	parts.push(buildFileSummaryTable(summary));
	const excluded = renderExcludedFiles(summary);
	if (excluded) parts.push(excluded);
	parts.push("");

	// ── Diff (inline, or file-list + read instruction when oversized) ──

	parts.push(renderDiffSection(summary, filtered, "### Diff"));
	parts.push("");

	// ── Custom Review Focus ──

	if (opts.focus) {
		parts.push("## Custom Review Focus");
		parts.push(opts.focus);
		parts.push("");
	}

	// ── Project Context ──

	if (opts.projectContext) {
		parts.push("## Additional Context");
		parts.push(opts.projectContext);
		parts.push("");
	}

	// ── Review Instructions ──

	parts.push("## Review Instructions");
	parts.push(
		"Review the changes above against the task description. Check for:",
	);
	parts.push(...reviewInstructions());
	parts.push("");
	parts.push(
		"Provide a concise review with any issues found. Your free-form prose",
	);
	parts.push("precedes the structured verdict block below.");
	parts.push(...reviewVerdictBlock());

	return parts.join("\n");
}

// ─── Uncommitted-Changes Review Prompt ──────────────────────────────────────

/**
 * Build a review prompt for uncommitted working-tree changes (pre-commit).
 * Used in review-gated mode: the review runs BEFORE committing so a rejected
 * review triggers a re-execution instead of a bad commit.
 */
export function buildReviewPromptUncommitted(
	task: Task,
	project: Project,
	status: string,
	diff: string,
	opts: ReviewPromptOptions = {},
): string {
	const parts: string[] = [];

	parts.push(`# Code Review (pre-commit): Task ${task.id}: ${task.title}`);
	parts.push("");

	// ── Task Description ──

	parts.push("## Task Description");
	if (task.description) {
		parts.push(task.description);
	} else {
		parts.push(task.title);
	}
	parts.push("");

	// ── Task Specification ──

	if (task.file) {
		const spec = readTaskSpec(project.sourceDir, task.file);
		if (spec) {
			parts.push("## Task Specification");
			parts.push(`Full details from \`${task.file}\`:`);
			parts.push("");
			parts.push(spec);
			parts.push("");
		}
	}

	// ── Uncommitted Changes Under Review ──

	parts.push("## Uncommitted Changes Under Review");
	parts.push(
		"Review the working-tree changes below against the task description.",
	);
	parts.push("");
	parts.push("### Current Changes (git status --porcelain)");
	parts.push("```text");
	parts.push(status || "(no status output)");
	parts.push("```");
	parts.push("");

	// ── Changed-Files Summary + Exclusions (noise-filtered scope) ──

	const summary = parseDiff(diff, opts.diffOptions);
	const filtered = filterNoise(diff, opts.diffOptions);
	parts.push(buildFileSummaryTable(summary));
	const excluded = renderExcludedFiles(summary);
	if (excluded) parts.push(excluded);
	parts.push("");

	// ── Diff (inline, or file-list + read instruction when oversized) ──

	parts.push(
		renderDiffSection(summary, filtered, "### Current Tracked Diff (git diff)"),
	);
	parts.push("");

	// ── Custom Review Focus ──

	if (opts.focus) {
		parts.push("## Custom Review Focus");
		parts.push(opts.focus);
		parts.push("");
	}

	// ── Project Context ──

	if (opts.projectContext) {
		parts.push("## Additional Context");
		parts.push(opts.projectContext);
		parts.push("");
	}

	// ── Review Instructions ──

	parts.push("## Review Instructions");
	parts.push(
		"Review the uncommitted changes above against the task description. Check for:",
	);
	parts.push(...reviewInstructions());
	parts.push("");
	parts.push(
		"Provide a concise review with any issues found. Your free-form prose",
	);
	parts.push("precedes the structured verdict block below.");
	parts.push(...reviewVerdictBlock());

	return parts.join("\n");
}

// ─── Shared Review Prompt Helpers ───────────────────────────────────────────

/** Whether an oversized/wide diff should be replaced by a file-list + read
 *  instruction instead of being inlined. Thresholds: cleaned diff over
 *  MAX_DIFF_BYTES, or more than MAX_REVIEW_FILES included files. */
function shouldSkipInline(summary: DiffSummary, filteredLength: number): boolean {
	return (
		filteredLength > MAX_DIFF_BYTES || summary.files.length > MAX_REVIEW_FILES
	);
}

/**
 * Render a per-file +/− summary Markdown table (with type column and a total
 * line) from a parsed diff. Handles the empty/all-noise diff gracefully — an
 * empty table with zero totals, no crash.
 */
function buildFileSummaryTable(summary: DiffSummary): string {
	const lines: string[] = [];
	lines.push("### Changed Files");
	lines.push("");
	lines.push("| File | +/− | Type |");
	lines.push("|------|-----|------|");
	if (summary.files.length === 0) {
		lines.push("| _(no included changes)_ | — | — |");
	} else {
		for (const f of summary.files) {
			lines.push(
				`| \`${f.path}\` | +${f.linesAdded}/-${f.linesRemoved} | ${f.ext || "—"} |`,
			);
		}
	}
	lines.push(`| **Total** | **+${summary.totalAdded}/-${summary.totalRemoved}** | |`);
	return lines.join("\n");
}

/**
 * Render the `### Excluded Files (n)` bullet list (path, +/− counts, reason).
 * Returns an empty string when there are no exclusions so callers omit the
 * section entirely (no empty heading).
 */
function renderExcludedFiles(summary: DiffSummary): string {
	if (summary.excluded.length === 0) return "";
	const lines: string[] = [];
	lines.push(`### Excluded Files (${summary.excluded.length})`);
	lines.push("");
	for (const f of summary.excluded) {
		lines.push(
			`- \`${f.path}\` (+${f.linesAdded}/-${f.linesRemoved}) — ${f.reason}`,
		);
	}
	return lines.join("\n");
}

/**
 * Render the diff section of a review prompt. Under the threshold, inline the
 * noise-filtered diff. Over the threshold (size or file count), emit a
 * file-list + read-instruction notice and never byte-truncate the diff.
 */
function renderDiffSection(
	summary: DiffSummary,
	filtered: string,
	heading: string,
): string {
	if (shouldSkipInline(summary, filtered.length)) {
		return `${heading} — _Diff too large (${filtered.length.toLocaleString()} chars, ${summary.files.length} files). Use \`read\` to inspect the changed files._`;
	}
	const lines: string[] = [];
	lines.push(heading);
	lines.push("```diff");
	lines.push(filtered || "(no included changes)");
	lines.push("```");
	return lines.join("\n");
}

function reviewInstructions(): string[] {
	return [
		"- **Correctness**: Does the implementation fulfill the task requirements?",
		"- **Completeness**: Are all aspects of the task addressed?",
		"- **Code quality**: Are there obvious bugs, anti-patterns, or issues?",
		"- **Missing changes**: Are there files that should have been modified but weren't?",
	];
}

function reviewVerdictBlock(): string[] {
	return [
		"## REVIEW VERDICT (REQUIRED)",
		"End your response with a verdict block in EXACTLY this format:",
		"",
		"```",
		"## REVIEW VERDICT",
		"VERDICT: [pass | warn | fail]",
		"SUMMARY: [1-2 sentence overall assessment]",
		"FINDINGS:",
		"- [blocker] file:line description  (use severity: blocker|warning|nit|info; `critical` is accepted as a blocker synonym)",
		"- [warning] file:line description",
		"```",
		"",
		"Verdict guidance:",
		"- **pass**: the implementation fully satisfies the task requirements; no",
		"  action needed. Use an empty FINDINGS section (just the header).",
		"- **warn**: the implementation is acceptable but has minor issues worth fixing",
		"  in a follow-up; not blocking.",
		"- **fail**: the implementation does not satisfy the task, or has serious bugs",
		"  that must be fixed before proceeding.",
		"",
		"Each FINDINGS line uses the form `- [severity] [file:line] message`.",
		"The `file:line` part is optional. Severity must be one of:",
		"`blocker`, `warning`, `nit`, `info`. The `critical` token is accepted",
		"and treated as `blocker`.",
	];
}

/**
 * Build the prompt for a dry-run / plan display
 */
export function buildPlanPrompt(project: Project): string {
	const lines: string[] = [];

	lines.push("# Project Plan");
	lines.push("");

	if (project.objective) {
		lines.push("## Objective");
		lines.push(project.objective);
		lines.push("");
	}

	lines.push("## Tasks");
	for (const task of project.tasks) {
		const deps =
			task.dependencies.length > 0
				? ` (depends on: ${task.dependencies.join(", ")})`
				: "";
		lines.push(`- [ ] ${task.id}: ${task.title}${deps}`);
	}
	lines.push("");

	if (project.exitCriteria && project.exitCriteria.length > 0) {
		lines.push("## Exit Criteria");
		for (const criterion of project.exitCriteria) {
			lines.push(`- ${criterion}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ─── Conflict Resolution Prompt ─────────────────────────────────────────────

/**
 * Build the prompt for a conflict-resolution agent session.
 *
 * The main repo is in a merge-conflict state (from `reattemptMerge`). The
 * agent must resolve all conflict markers in the conflicted files, stage the
 * resolved files, and commit to complete the merge.
 */
export function buildConflictResolutionPrompt(
	task: Task,
	project: Project,
	conflicts: string[],
	branch: string,
	projectContext?: string,
): string {
	const parts: string[] = [];

	parts.push(`# Merge Conflict Resolution: Task ${task.id}: ${task.title}`);
	parts.push("");
	parts.push(
		`A merge of branch \`${branch}\` into the current branch produced conflicts.`,
	);
	parts.push("You must resolve all conflicts and complete the merge.");
	parts.push("");

	// ── Task Context ──

	parts.push("## Task Description");
	if (task.description) {
		parts.push(task.description);
	} else {
		parts.push(task.title);
	}
	parts.push("");

	// ── Task Specification ──

	if (task.file) {
		const spec = readTaskSpec(project.sourceDir, task.file);
		if (spec) {
			parts.push("## Task Specification");
			parts.push(`Full details from \`${task.file}\`:`);
			parts.push("");
			parts.push(spec);
			parts.push("");
		}
	}

	// ── Conflicted Files ──

	parts.push("## Conflicted Files");
	parts.push(
		"The following files have unresolved merge conflicts (conflict markers `<<<<<<<`, `=======`, `>>>>>>>`):",
	);
	parts.push("");
	for (const f of conflicts) {
		parts.push(`- \`${f}\``);
	}
	parts.push("");

	// ── Project Context ──

	if (projectContext) {
		parts.push("## Additional Context");
		parts.push(projectContext);
		parts.push("");
	}

	// ── Resolution Instructions ──

	parts.push("## Resolution Instructions");
	parts.push(
		"1. Read each conflicted file to understand both sides of the conflict.",
	);
	parts.push(
		"2. Edit each file to remove all conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).",
	);
	parts.push(
		"   Keep the correct changes from both sides — do NOT blindly pick one side.",
	);
	parts.push(
		"   The goal is a correct union of both the task's changes and the main branch.",
	);
	parts.push(
		"3. After resolving all conflicts, stage the resolved files with `git add <files>`.",
	);
	parts.push(
		"4. Complete the merge with `git commit` — use the default merge message.",
	);
	parts.push("");
	parts.push(
		"Resolve ALL conflicts. Do NOT abort the merge. Do NOT leave any conflict markers.",
	);

	return parts.join("\n");
}
