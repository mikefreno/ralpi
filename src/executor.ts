import * as fs from "node:fs";
import * as path from "node:path";
import type { Task, Project, ExecutionPlan, Reflection } from "./types";
import type { RalphConfig } from "./types";
import { ProgressTracker } from "./progress";
import { buildTaskPrompt } from "./prompts";
import { extractReflection } from "./reflection";
import { getPiPath, spawnPi, extractTextFromEvent, writeFileSafe, ensureDir } from "./utils";

// ─── Run Single Task ────────────────────────────────────────────────────────

/**
 * Execute a single task by spawning pi with the task prompt
 */
export async function runTask(
	task: Task,
	project: Project,
	config: RalphConfig,
	depReflections: Reflection[],
): Promise<{ success: boolean; reflection?: Reflection; error?: string; durationMs: number }> {
	const startMs = Date.now();
	const piPath = getPiPath();

	// Build prompt
	const prompt = buildTaskPrompt(
		task,
		project,
		depReflections,
		config.prompts.projectContext,
	);

	// Write prompt to temp file
	const promptDir = path.join(project.sourceDir, ".ralph", "prompts");
	ensureDir(promptDir);
	const promptFile = path.join(promptDir, `${task.id}.md`);
	writeFileSafe(promptFile, prompt);

	console.log(`[ralph] Running task ${task.id}: ${task.title}`);
	console.log(`[ralph] Prompt written to ${promptFile}`);

	// Spawn pi
	const result = spawnPi(promptFile, piPath, config.execution.maxParallel > 0 ? [] : []);

	const durationMs = Date.now() - startMs;

	if (result.code !== 0) {
		return {
			success: false,
			error: result.stderr || `pi exited with code ${result.code}`,
			durationMs,
		};
	}

	// Extract output text
	const output = extractTextFromEvent(result.stdout);

	// Extract reflection
	const reflection = extractReflection(output, task.id, task.title);

	return {
		success: true,
		reflection,
		durationMs,
	};
}

// ─── Execute Batch ───────────────────────────────────────────────────────────

/**
 * Execute a batch of tasks (sequentially or in parallel)
 */
export async function executeBatch(
	batchIndex: number,
	tasks: Task[],
	project: Project,
	config: RalphConfig,
	progress: ProgressTracker,
): Promise<void> {
	console.log(`\n[ralph] === Batch ${batchIndex + 1} (${tasks.length} task${tasks.length > 1 ? "s" : ""}) ===`);

	// For now, execute sequentially (parallel support requires more complex event handling)
	for (const task of tasks) {
		await executeTask(task, project, config, progress);
	}
}

// ─── Execute Single Task with Retry ──────────────────────────────────────────

async function executeTask(
	task: Task,
	project: Project,
	config: RalphConfig,
	progress: ProgressTracker,
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
			const result = await runTask(task, project, config, depReflections);

			if (result.success) {
				// Save reflection
				if (result.reflection) {
					saveReflectionToFile(project.sourceDir, config, result.reflection);
				}

				// Mark completed
				progress.markCompleted(task.id, result.durationMs, result.reflection);
				console.log(`[ralph] Task ${task.id} completed in ${formatMs(result.durationMs)}`);
				return;
			}

			// Task failed, check if we should retry
			if (retries < maxRetries) {
				retries = progress.incrementRetry(task.id);
				console.log(
					`[ralph] Task ${task.id} failed (attempt ${retries}/${maxRetries}): ${result.error}`,
				);

				// Exponential backoff
				const delay = config.execution.retryDelayMs * Math.pow(2, retries - 1);
				await sleep(delay);
			} else {
				// Max retries exceeded
				progress.markFailed(task.id, result.error || "Unknown error");
				console.log(`[ralph] Task ${task.id} FAILED after ${maxRetries} retries`);
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
	return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMs(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds >= 60) {
		const minutes = Math.floor(seconds / 60);
		const remainSec = seconds % 60;
		return `${minutes}m ${remainSec}s`;
	}
	return `${seconds}s`;
}
