// ─── Task Model ───────────────────────────────────────────────────────────────

export type TaskStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "failed"
	| "skipped";
export type TaskStatusChar = " " | "~" | "x" | "!" | "-";

export interface Task {
	/** Unique task identifier */
	id: string;
	/** Task title */
	title: string;
	/** Detailed task description */
	description?: string;
	/** Path to detailed spec file (relative to sourceDir) */
	file?: string;
	/** Current status */
	status: TaskStatus;
	/** Task IDs this task depends on */
	dependencies: string[];
	/** Explicit parallel group (optional, overrides dependency-based batching) */
	parallelGroup?: number;
	/** Task-level timeout in milliseconds (parsed from meta block) */
	timeoutMs?: number;
	/** Original index in task list for deterministic ordering */
	index?: number;
}

export interface Project {
	/** Project-level objective / goal */
	objective?: string;
	/** All tasks in the project */
	tasks: Task[];
	/** Explicit dependency map: taskId → [dependency taskIds] */
	dependencies: Record<string, string[]>;
	/** Exit criteria (from README ## Exit Criteria section) */
	exitCriteria?: string[];
	/** Path to the source task file */
	sourcePath: string;
	/** Directory containing the source file */
	sourceDir: string;
}

// ─── Execution Plan ───────────────────────────────────────────────────────────

export interface ExecutionBatch {
	/** Tasks that can run concurrently in this batch */
	tasks: Task[];
	/** Batch number (0-indexed) */
	batchIndex: number;
}

export interface ExecutionPlan {
	/** Ordered batches (each batch contains parallelizable tasks) */
	batches: ExecutionBatch[];
	/** Total task count */
	totalTasks: number;
	/** Tasks skipped (already completed) */
	skippedTasks: Task[];
}

// ─── Progress Model ───────────────────────────────────────────────────────────

export interface Reflection {
	taskId: string;
	title: string;
	/** What was accomplished */
	summary: string;
	/** Key decisions, patterns, and learnings for downstream tasks */
	keyLearnings: string[];
	/** Files created or modified */
	filesChanged: string[];
	/** Unresolved issues or caveats */
	blockers?: string[];
	/** ISO timestamp */
	timestamp: string;
}

export interface ToolUsage {
	read: number;
	write: number;
	edit: number;
	bash: number;
	other: number;
}

export interface TaskProgressInfo {
	status: Task["status"];
	startedAt?: string;
	completedAt?: string;
	retries: number;
	durationMs?: number;
	reflection?: Reflection;
	error?: string;
	/** Tool usage counts from parsed subprocess output */
	toolUsage?: ToolUsage;
	/** Path to session output file */
	sessionFile?: string;
	/** Truncated output preview for expanded view */
	outputPreview?: string;
	/** Git commit messages from task execution */
	commitMessages?: string[];
	/** Summary derived from git commits */
	commitSummary?: string;
}

export interface ProgressState {
	/** Path to the source task file (legacy single-PRD mode) */
	sourcePath: string;
	/** Per-task status tracking (legacy single-PRD mode) */
	tasks: Record<string, TaskProgressInfo>;
	/** When execution started (legacy single-PRD mode) */
	startedAt: string;
	/** When execution last updated (legacy single-PRD mode) */
	lastUpdatedAt: string;
	/** Whether execution is currently paused/stopped (legacy single-PRD mode) */
	paused: boolean;
	/** Multiple PRDs tracked simultaneously (keyed by normalized source path) */
	prds?: Record<string, PRDProgress>;
}

export interface PRDProgress {
	/** Path to the source task file for this PRD */
	sourcePath: string;
	/** Per-task status tracking */
	tasks: Record<string, TaskProgressInfo>;
	/** When execution started */
	startedAt: string;
	/** When execution last updated */
	lastUpdatedAt: string;
	/** Whether execution is currently paused/stopped */
	paused: boolean;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface RalphConfig {
	paths: {
		/** Directory for ralph state files */
		stateDir: string;
		/** Directory for per-task reflections */
		reflectionsDir: string;
	};
	execution: {
		/** Maximum retries per task */
		maxRetries: number;
		/** Delay between retries in milliseconds */
		retryDelayMs: number;
		/** Task execution timeout in milliseconds */
		timeoutMs: number;
		/** Maximum parallel tasks (0 = unlimited) */
		maxParallel: number;
	};
	prompts: {
		/** Additional context injected into every task prompt */
		projectContext: string;
		/** Custom prompt suffix for reflection extraction */
		reflectionPrompt: string;
	};
}

export const DEFAULT_CONFIG: RalphConfig = {
	paths: {
		stateDir: ".ralph",
		reflectionsDir: ".ralph/reflections",
	},
	execution: {
		maxRetries: 3,
		retryDelayMs: 5000,
		timeoutMs: 30 * 60 * 1000, // 30 minutes
		maxParallel: 3,
	},
	prompts: {
		projectContext: "",
		reflectionPrompt: "",
	},
};
