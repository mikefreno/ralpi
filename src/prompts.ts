import type { Task, Project, Reflection } from "./types";
import { readTaskSpec } from "./parser";

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

// ─── Plan Prompt ─────────────────────────────────────────────────────────────

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
		const deps = task.dependencies.length > 0
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
