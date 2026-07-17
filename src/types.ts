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
	/** Phase number this task belongs to (1-indexed, from ## Phase N headings) */
	phase?: number;
}

export interface ParallelGroup {
	/** Group index (0-based, determines execution order) */
	index: number;
	/** Human-readable label for the group (e.g. "Play Store prep") */
	label?: string;
	/** Task IDs in this group — all can run concurrently */
	taskIds: string[];
}

export interface Phase {
	/** Phase number (1-indexed, matches the heading number) */
	number: number;
	/** Phase title (e.g. "Push-to-Talk MVP") */
	title: string;
	/** Task IDs in this phase, in order */
	taskIds: string[];
}

export interface Project {
	/** Project-level objective / goal */
	objective?: string;
	/** All tasks in the project */
	tasks: Task[];
	/** Explicit dependency map: taskId → [dependency taskIds] */
	dependencies: Record<string, string[]>;
	/** Explicit parallel groups from "can be done in parallel" declarations */
	parallelGroups?: ParallelGroup[];
	/** Phased sections from ## Phase N headings (in order) */
	phases?: Phase[];
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
	durationMs?: number;
	reflection?: Reflection;
	error?: string;
	/** Tool usage counts from parsed subprocess output */
	toolUsage?: ToolUsage;
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

export interface RalpiConfig {
	paths: {
		/** Directory for ralpi state files */
		stateDir: string;
		/** Directory for per-task reflections */
		reflectionsDir: string;
	};
	execution: {
		/** Task execution timeout in milliseconds */
		timeoutMs: number;
		/** Maximum parallel tasks (0 = unlimited) */
		maxParallel: number;
		/** Round-robin model list for parallel tasks (empty = inherit parent model) */
		models: string[];
		/** Spawn a follow-up agent to commit changes after each task completes */
		autoCommit: boolean;
		/** Spawn a review agent to review the commit against the task description */
		autoReview: boolean;
		/** Keys under `execution:` explicitly present in a loaded config YAML.
		 *  Used to skip interactive prompts for fields the user already set. */
		explicitKeys?: Set<string>;
		/** Model for commit sessions in <provider>/<model> format (empty = inherit task model) */
		commitModel: string;
		/** Model for review sessions in <provider>/<model> format (empty = inherit task model) */
		reviewModel: string;
		/** Model for task implementation in <provider>/<model> format (empty = inherit parent model; only used in sequential mode when models is empty) */
		implModel: string;
		/** Timeout for auto-commit agent sessions in milliseconds */
		commitTimeoutMs: number;
		/** Timeout for auto-review agent sessions in milliseconds */
		reviewTimeoutMs: number;
		/** Maximum total duration for the entire loop execution in milliseconds (0 = no limit). Checked between batches — in-progress tasks finish naturally. */
		loopTimeoutMs: number;
	};
	prompts: {
		/** Additional context injected into every task prompt */
		projectContext: string;
		/** Custom prompt suffix for reflection extraction */
		reflectionPrompt: string;
	};
	/** Parent session model to inherit in child agent sessions */
	model?: unknown;
	/** Parent session thinking level to inherit in child agent sessions */
	thinkingLevel?: unknown;
}

export const DEFAULT_CONFIG: RalpiConfig = {
	paths: {
		stateDir: ".ralpi",
		reflectionsDir: ".ralpi/reflections",
	},
	execution: {
		timeoutMs: 0, // 0 = inherit Pi's own defaults (no ralpi-level timeout)
		maxParallel: 3,
		models: [],
		autoCommit: true,
		autoReview: false,
		commitModel: "",
		reviewModel: "",
		implModel: "",
		commitTimeoutMs: 0, // 0 = inherit Pi's own defaults (no ralpi-level timeout)
		reviewTimeoutMs: 0, // 0 = inherit Pi's own defaults (no ralpi-level timeout)
		loopTimeoutMs: 0, // 0 = no limit
	},
	prompts: {
		projectContext: "",
		reflectionPrompt: "",
	},
};
