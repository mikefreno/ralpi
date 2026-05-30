import * as path from "node:path";
import type { ExtensionContext } from "@pi/extension-api";
import { parseTaskFile, updateTaskInFile } from "./parser";
import { buildExecutionPlan, buildSequentialPlan, formatExecutionPlan, getReadyTasks } from "./dag";
import { ProgressTracker } from "./progress";
import { buildPlanPrompt } from "./prompts";
import { formatReflections } from "./reflection";
import { executeBatch } from "./executor";
import { loadConfig, resolveTaskArg, formatProgressStatus, getPiPath } from "./utils";
import { COMMANDS } from "./constants";

// ─── Extension Entry ────────────────────────────────────────────────────────

export function register(context: ExtensionContext) {
	context.registerSlashCommand({
		name: "ralph",
		description: "Execute tasks from a task file using DAG-based dependency resolution",
		handler: async (args: string[]) => {
			const [subcommand, ...rest] = args;
			const command = subcommand || "plan";

			switch (command) {
				case "run":
					return handleRun(context, rest);
				case "plan":
					return handlePlan(context, rest);
				case "status":
					return handleStatus(context, rest);
				case "resume":
					return handleResume(context, rest);
				case "next":
					return handleNext(context, rest);
				case "reset":
					return handleReset(context, rest);
				default:
					return `Unknown command: ${command}\nAvailable: ${COMMANDS.join(", ")}`;
			}
		},
	});
}

// ─── /ralph plan ─────────────────────────────────────────────────────────────

async function handlePlan(context: ExtensionContext, args: string[]): Promise<string> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());
	const project = parseTaskFile(taskFile);

	// Show plan
	const planPrompt = buildPlanPrompt(project);
	const plan = buildExecutionPlan(project, new Set());
	const formatted = formatExecutionPlan(plan);

	return `${planPrompt}\n\n${formatted}`;
}

// ─── /ralph run ──────────────────────────────────────────────────────────────

async function handleRun(context: ExtensionContext, args: string[]): Promise<string> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());
	const project = parseTaskFile(taskFile);
	const config = loadConfig(process.cwd());
	const progress = new ProgressTracker(process.cwd(), taskFile);

	// Build execution plan
	const completed = new Set(progress.getCompletedTaskIds());
	const plan = buildExecutionPlan(project, completed);

	// Execute batches
	for (const batch of plan.batches) {
		// Check if paused
		if (progress.getState().paused) {
			return `Execution paused. Use /ralph resume to continue.`;
		}

		await executeBatch(
			batch.batchIndex,
			batch.tasks,
			project,
			config,
			progress,
		);

		// Update task file
		for (const task of batch.tasks) {
			const status = progress.getTaskStatus(task.id);
			updateTaskInFile(taskFile, task.id, status);
		}
	}

	// Final status
	const state = progress.getState();
	const output = formatProgressStatus(state);

	// Show reflections
	const reflections = progress.getAllReflections();
	if (reflections.length > 0) {
		return `${output}\n\n${formatReflections(reflections)}`;
	}

	return output;
}

// ─── /ralph status ───────────────────────────────────────────────────────────

async function handleStatus(context: ExtensionContext, args: string[]): Promise<string> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());
	const progress = new ProgressTracker(process.cwd(), taskFile);
	return formatProgressStatus(progress.getState());
}

// ─── /ralph resume ───────────────────────────────────────────────────────────

async function handleResume(context: ExtensionContext, args: string[]): Promise<string> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());
	const project = parseTaskFile(taskFile);
	const config = loadConfig(process.cwd());
	const progress = new ProgressTracker(process.cwd(), taskFile);

	// Unpause
	progress.setPaused(false);

	// Get remaining batches
	const completed = new Set(progress.getCompletedTaskIds());
	const plan = buildExecutionPlan(project, completed);

	// Execute remaining batches
	for (const batch of plan.batches) {
		await executeBatch(
			batch.batchIndex,
			batch.tasks,
			project,
			config,
			progress,
		);

		// Update task file
		for (const task of batch.tasks) {
			const status = progress.getTaskStatus(task.id);
			updateTaskInFile(taskFile, task.id, status);
		}
	}

	return formatProgressStatus(progress.getState());
}

// ─── /ralph next ─────────────────────────────────────────────────────────────

async function handleNext(context: ExtensionContext, args: string[]): Promise<string> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());
	const project = parseTaskFile(taskFile);
	const config = loadConfig(process.cwd());
	const progress = new ProgressTracker(process.cwd(), taskFile);

	const completed = new Set(progress.getCompletedTaskIds());
	const ready = getReadyTasks(project, completed);

	if (ready.length === 0) {
		return "No tasks ready to execute. All tasks completed or blocked.";
	}

	// Execute just the next batch (first ready tasks)
	const nextBatch = ready.slice(0, config.execution.maxParallel || ready.length);

	for (const task of nextBatch) {
		await executeBatch(
			0,
			[task],
			project,
			config,
			progress,
		);

		updateTaskInFile(taskFile, task.id, progress.getTaskStatus(task.id));
	}

	return `Executed: ${nextBatch.map(t => t.id).join(", ")}\n\n${formatProgressStatus(progress.getState())}`;
}

// ─── /ralph reset ────────────────────────────────────────────────────────────

async function handleReset(context: ExtensionContext, args: string[]): Promise<string> {
	const taskFile = resolveTaskArg(args[0] || "README.md", process.cwd());
	const progress = new ProgressTracker(process.cwd(), taskFile);
	progress.reset();

	return "Progress reset. All task statuses cleared.";
}
