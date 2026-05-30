import * as fs from "node:fs";
import * as path from "node:path";
import type { ProgressState, Task, Reflection } from "./types";
import { ensureDir } from "./utils";

/**
 * Manages persistent progress state for a ralph execution.
 * State is stored as JSON in .ralph/progress.json
 */
export class ProgressTracker {
	private statePath: string;
	private state: ProgressState;

	constructor(projectDir: string, sourcePath: string) {
		const stateDir = path.join(projectDir, ".ralph");
		ensureDir(stateDir);
		this.statePath = path.join(stateDir, "progress.json");
		this.state = this.loadOrCreate(sourcePath);
	}

	/** Load existing state or create a fresh one */
	private loadOrCreate(sourcePathHint: string): ProgressState {
		if (fs.existsSync(this.statePath)) {
			try {
				const raw = fs.readFileSync(this.statePath, "utf-8");
				return JSON.parse(raw) as ProgressState;
			} catch {
				// Fall through to create new
			}
		}
		return {
			sourcePath: sourcePathHint,
			tasks: {},
			startedAt: new Date().toISOString(),
			lastUpdatedAt: new Date().toISOString(),
			paused: false,
		};
	}

	/** Save current state to disk */
	save(): void {
		this.state.lastUpdatedAt = new Date().toISOString();
		fs.writeFileSync(
			this.statePath,
			JSON.stringify(this.state, null, 2),
			"utf-8",
		);
	}

	/** Mark a task as in progress */
	markInProgress(taskId: string): void {
		this.ensureTask(taskId);
		this.state.tasks[taskId].status = "in_progress";
		this.state.tasks[taskId].startedAt = new Date().toISOString();
		this.save();
	}

	/** Mark a task as completed */
	markCompleted(
		taskId: string,
		durationMs: number,
		reflection?: Reflection,
	): void {
		this.ensureTask(taskId);
		this.state.tasks[taskId].status = "completed";
		this.state.tasks[taskId].completedAt = new Date().toISOString();
		this.state.tasks[taskId].durationMs = durationMs;
		if (reflection) {
			this.state.tasks[taskId].reflection = reflection;
		}
		this.save();
	}

	/** Mark a task as failed */
	markFailed(taskId: string, error: string): void {
		this.ensureTask(taskId);
		this.state.tasks[taskId].status = "failed";
		this.state.tasks[taskId].error = error;
		this.save();
	}

	/** Get task status */
	getTaskStatus(taskId: string): Task["status"] {
		return this.state.tasks[taskId]?.status ?? "pending";
	}

	/** Get IDs of all completed tasks */
	getCompletedTaskIds(): string[] {
		return Object.entries(this.state.tasks)
			.filter(([, info]) => info.status === "completed")
			.map(([id]) => id);
	}

	/** Get all reflections from completed tasks */
	getAllReflections(): Reflection[] {
		const reflections: Reflection[] = [];
		for (const info of Object.values(this.state.tasks)) {
			if (info.reflection) {
				reflections.push(info.reflection);
			}
		}
		return reflections;
	}

	/** Get reflections for specific dependency tasks */
	getDependencyReflections(depIds: string[]): Reflection[] {
		return depIds
			.map((id) => this.state.tasks[id]?.reflection)
			.filter((r): r is Reflection => r !== undefined);
	}

	/** Increment retry count */
	incrementRetry(taskId: string): number {
		this.ensureTask(taskId);
		this.state.tasks[taskId].retries++;
		this.save();
		return this.state.tasks[taskId].retries;
	}

	/** Set paused state */
	setPaused(paused: boolean): void {
		this.state.paused = paused;
		this.save();
	}

	/** Get the raw state (for status display) */
	getState(): ProgressState {
		return this.state;
	}

	/** Reset all progress */
	reset(): void {
		this.state = {
			sourcePath: this.state.sourcePath,
			tasks: {},
			startedAt: new Date().toISOString(),
			lastUpdatedAt: new Date().toISOString(),
			paused: false,
		};
		this.save();
	}

	private ensureTask(taskId: string): void {
		if (!this.state.tasks[taskId]) {
			this.state.tasks[taskId] = { status: "pending", retries: 0 };
		}
	}
}
