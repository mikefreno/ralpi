import * as fs from "node:fs";
import * as path from "node:path";
import type { ProgressState, PRDProgress, Task, Reflection, ToolUsage } from "./types";
import { ensureDir } from "./utils";

/**
 * Derive a stable PRD key from a source path relative to the project dir.
 * e.g., "tasks/feature-x/README.md" → "tasks-feature-x-README"
 */
export function derivePRDKey(projectDir: string, sourcePath: string): string {
	const rel = path.relative(projectDir, sourcePath);
	return rel.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Manages persistent progress state for a ralph execution.
 * State is stored as JSON in .ralph/progress.json.
 * Supports multiple PRDs in progress simultaneously via the `prds` field.
 * Falls back to legacy flat format for backward compatibility.
 */
export class ProgressTracker {
	private statePath: string;
	private state: ProgressState;
	private prdKey: string;

	constructor(projectDir: string, sourcePath: string, prdKey?: string) {
		const stateDir = path.join(projectDir, ".ralph");
		ensureDir(stateDir);
		this.statePath = path.join(stateDir, "progress.json");
		this.prdKey = prdKey ?? derivePRDKey(projectDir, sourcePath);
		this.state = this.loadOrCreate(sourcePath);
	}

	/** Load existing state or create a fresh one */
	private loadOrCreate(sourcePathHint: string): ProgressState {
		if (fs.existsSync(this.statePath)) {
			try {
				const raw = fs.readFileSync(this.statePath, "utf-8");
				const parsed = JSON.parse(raw) as ProgressState;

				// Multi-PRD mode: check if we have a PRD entry
				if (parsed.prds?.[this.prdKey]) {
					// Found PRD entry — use it, but keep legacy fields for compat
					return parsed;
				}

				// Legacy flat mode: check if the source path matches
				if (path.resolve(parsed.sourcePath) === path.resolve(sourcePathHint)) {
					// Migrate legacy state to PRD mode
					parsed.prds = {
						[this.prdKey]: {
							sourcePath: parsed.sourcePath,
							tasks: parsed.tasks,
							startedAt: parsed.startedAt,
							lastUpdatedAt: parsed.lastUpdatedAt,
							paused: parsed.paused,
						},
					};
					return parsed;
				}

				// Different PRD — create new entry alongside existing ones
				if (parsed.prds) {
					parsed.prds[this.prdKey] = this.freshPRD(sourcePathHint);
					return parsed;
				}

				// Legacy flat state exists but for a different source — promote it to PRD mode
				const legacyKey = derivePRDKey(path.dirname(this.statePath), parsed.sourcePath);
				parsed.prds = {
					[legacyKey]: {
						sourcePath: parsed.sourcePath,
						tasks: parsed.tasks,
						startedAt: parsed.startedAt,
						lastUpdatedAt: parsed.lastUpdatedAt,
						paused: parsed.paused,
					},
					[this.prdKey]: this.freshPRD(sourcePathHint),
				};
				return parsed;
			} catch {
				// Fall through to create new
			}
		}

		return this.freshState(sourcePathHint);
	}

	private freshPRD(sourcePath: string): PRDProgress {
		return {
			sourcePath,
			tasks: {},
			startedAt: new Date().toISOString(),
			lastUpdatedAt: new Date().toISOString(),
			paused: false,
		};
	}

	private freshState(sourcePath: string): ProgressState {
		return {
			sourcePath,
			tasks: {},
			startedAt: new Date().toISOString(),
			lastUpdatedAt: new Date().toISOString(),
			paused: false,
			prds: {
				[this.prdKey]: {
					sourcePath,
					tasks: {},
					startedAt: new Date().toISOString(),
					lastUpdatedAt: new Date().toISOString(),
					paused: false,
				},
			},
		};
	}

	/** Get the PRD-scoped progress entry */
	private getPRD(): PRDProgress {
		if (!this.state.prds) {
			// Should not happen after loadOrCreate, but guard anyway
			this.state.prds = { [this.prdKey]: this.freshPRD(this.state.sourcePath) };
		}
		if (!this.state.prds[this.prdKey]) {
			this.state.prds[this.prdKey] = this.freshPRD(this.state.sourcePath);
		}
		return this.state.prds[this.prdKey];
	}

	/** Save current state to disk */
	save(): void {
		const prd = this.getPRD();
		prd.lastUpdatedAt = new Date().toISOString();
		// Sync legacy flat fields with current PRD for backward compat
		this.state.sourcePath = prd.sourcePath;
		this.state.tasks = prd.tasks;
		this.state.startedAt = prd.startedAt;
		this.state.lastUpdatedAt = prd.lastUpdatedAt;
		this.state.paused = prd.paused;
		fs.writeFileSync(
			this.statePath,
			JSON.stringify(this.state, null, 2),
			"utf-8",
		);
	}

	/** Mark a task as in progress */
	markInProgress(taskId: string): void {
		const prd = this.getPRD();
		this.ensureTask(prd, taskId);
		prd.tasks[taskId].status = "in_progress";
		prd.tasks[taskId].startedAt = new Date().toISOString();
		this.save();
	}

	/** Mark a task as completed */
	markCompleted(
		taskId: string,
		durationMs: number,
		reflection?: Reflection,
		toolUsage?: ToolUsage,
		sessionFile?: string,
		outputPreview?: string,
		commitMessages?: string[],
		commitSummary?: string,
	): void {
		const prd = this.getPRD();
		this.ensureTask(prd, taskId);
		prd.tasks[taskId].status = "completed";
		prd.tasks[taskId].completedAt = new Date().toISOString();
		prd.tasks[taskId].durationMs = durationMs;
		if (reflection) prd.tasks[taskId].reflection = reflection;
		if (toolUsage) prd.tasks[taskId].toolUsage = toolUsage;
		if (sessionFile) prd.tasks[taskId].sessionFile = sessionFile;
		if (outputPreview) prd.tasks[taskId].outputPreview = outputPreview;
		if (commitMessages) prd.tasks[taskId].commitMessages = commitMessages;
		if (commitSummary) prd.tasks[taskId].commitSummary = commitSummary;
		this.save();
	}

	/** Mark a task as failed */
	markFailed(taskId: string, error: string): void {
		const prd = this.getPRD();
		this.ensureTask(prd, taskId);
		prd.tasks[taskId].status = "failed";
		prd.tasks[taskId].error = error;
		this.save();
	}

	/** Get task status */
	getTaskStatus(taskId: string): Task["status"] {
		const prd = this.getPRD();
		return prd.tasks[taskId]?.status ?? "pending";
	}

	/** Get IDs of all completed tasks */
	getCompletedTaskIds(): string[] {
		const prd = this.getPRD();
		return Object.entries(prd.tasks)
			.filter(([, info]) => info.status === "completed")
			.map(([id]) => id);
	}

	/** Get all reflections from completed tasks */
	getAllReflections(): Reflection[] {
		const prd = this.getPRD();
		const reflections: Reflection[] = [];
		for (const info of Object.values(prd.tasks)) {
			if (info.reflection) reflections.push(info.reflection);
		}
		return reflections;
	}

	/** Get reflections for specific dependency tasks */
	getDependencyReflections(depIds: string[]): Reflection[] {
		const prd = this.getPRD();
		return depIds
			.map((id) => prd.tasks[id]?.reflection)
			.filter((r): r is Reflection => r !== undefined);
	}

	/** Increment retry count */
	incrementRetry(taskId: string): number {
		const prd = this.getPRD();
		this.ensureTask(prd, taskId);
		prd.tasks[taskId].retries++;
		this.save();
		return prd.tasks[taskId].retries;
	}

	/** Set paused state */
	setPaused(paused: boolean): void {
		const prd = this.getPRD();
		prd.paused = paused;
		this.save();
	}

	/** Get the raw PRD state (for status display) */
	getState(): PRDProgress {
		return this.getPRD();
	}

	/** Get all PRDs (for multi-PRD status display) */
	getAllPRDs(): Record<string, PRDProgress> {
		return this.state.prds ?? {};
	}

	/** Get the PRD key for this tracker */
	getKey(): string {
		return this.prdKey;
	}

	/** Reset all progress for this PRD */
	reset(): void {
		const prd = this.getPRD();
		Object.assign(prd, this.freshPRD(prd.sourcePath));
		this.save();
	}

	private ensureTask(prd: PRDProgress, taskId: string): void {
		if (!prd.tasks[taskId]) {
			prd.tasks[taskId] = { status: "pending", retries: 0 };
		}
	}
}
