import type { Task, Project, Reflection, ReviewResult } from "./types";
import { readTaskSpec } from "./parser";

/** Maximum bytes of a commit diff embedded in a review/commit prompt.
 *  Diffs larger than this are truncated to avoid blowing past the model's
 *  context window. The agent can always run `git show HEAD` itself to
 *  inspect the full diff when it needs more detail.
 *
 *  ~50 KB ≈ 12.5K tokens — comfortably fits even on models with a 128K
 *  context window once system-prompt overhead is accounted for. */
export const MAX_DIFF_BYTES = 50_000;

/**
 * Truncate a diff to MAX_DIFF_BYTES, appending a clear notice when truncated.
 */
function truncateDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_BYTES) return diff;
	const omitted = diff.length - MAX_DIFF_BYTES;
	return (
		diff.slice(0, MAX_DIFF_BYTES) +
		"\n\n... (diff truncated: omitted " +
		omitted.toLocaleString() +
		" bytes; run `git show HEAD` to view the full diff)"
	);
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
	projectContext?: string,
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
	parts.push("### Diff");
	parts.push("```diff");
	parts.push(truncateDiff(commitDiff));
	parts.push("```");
	parts.push("");

	// ── Project Context ──

	if (projectContext) {
		parts.push("## Additional Context");
		parts.push(projectContext);
		parts.push("");
	}

	// ── Review Instructions ──

	parts.push("## Review Instructions");
	parts.push(
		"Review the commit above against the task description. Check for:",
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
	projectContext?: string,
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
	parts.push("### Current Tracked Diff (git diff)");
	parts.push("```diff");
	parts.push(truncateDiff(diff) || "(no tracked diff output)");
	parts.push("```");
	parts.push("");

	// ── Project Context ──

	if (projectContext) {
		parts.push("## Additional Context");
		parts.push(projectContext);
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
		"- [blocker] file:line description  (use severity: blocker|warning|nit|info)",
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
		"`blocker`, `warning`, `nit`, `info`.",
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
