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

// ─── Review Model ────────────────────────────────────────────────────────────

export type ReviewVerdict = "pass" | "warn" | "fail";

export interface ReviewFinding {
	/** Severity of the finding */
	severity: "blocker" | "warning" | "nit" | "info";
	/** File path if applicable */
	file?: string;
	/** Line number if applicable */
	line?: number;
	/** Description of the issue */
	message: string;
}

export interface ReviewResult {
	taskId: string;
	/** Overall verdict */
	verdict: ReviewVerdict;
	/** 1-2 sentence overall assessment */
	summary: string;
	/** Structured findings (empty when verdict is "pass") */
	findings: ReviewFinding[];
	/** Commit hash the review was performed against */
	commitHash: string;
	/** Full free-form review text (preserved for display) */
	rawText: string;
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
	/** Structured review result (when autoReview is enabled) */
	review?: ReviewResult;
	error?: string;
	/** Tool usage counts from parsed subprocess output */
	toolUsage?: ToolUsage;
	/** Truncated output preview for expanded view */
	outputPreview?: string;
	/** Git commit messages from task execution */
	commitMessages?: string[];
	/** Summary derived from git commits */
	commitSummary?: string;
	/** Number of review-fix re-execution attempts made (review-gated mode) */
	reviewRetries?: number;
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
		/** Directory for per-loop review output (mirrors reflectionsDir) */
		reviewsDir: string;
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
		/** Spawn a review agent to review the task's committed changes against
		 *  the task description. When autoReview is on, commit is mandated:
		 *  changes are committed (via commit session fallback when the agent
		 *  didn't self-commit), then the COMPLETE diff (baseRef..HEAD) is
		 *  reviewed. On 'fail' the task is re-executed with feedback (loops
		 *  until pass or maxReviewRetries). On pass the worktree merges.
		 *  When autoReview is off, autoCommit controls standalone commit. */
		autoReview: boolean;
		/** Persist the full review output to `.ralpi/reviews/<task-id>.md`.
		 *  Only active when autoReview is true and the user opts in at loop start. */
		saveReviews: boolean;
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
		/** Max review-fix re-execution attempts before giving up (0 = no retries;
		 *  review runs once, reject = stop). Active whenever autoReview is
		 *  enabled. On exhaustion the task proceeds with its committed changes
		 *  (the worktree merges) unless reviewBlockOnFail is set. */
		maxReviewRetries: number;
		/** When true, a 'fail' review verdict after exhausting maxReviewRetries
		 *  marks the task as failed instead of proceeding with its committed
		 *  changes (the worktree does not merge). */
		reviewBlockOnFail: boolean;
		/** Maximum total duration for the entire loop execution in milliseconds (0 = no limit). Checked between batches — in-progress tasks finish naturally. */
		loopTimeoutMs: number;
		/** Max attempts on the SAME model before cycling to the next model on
		 *  failure. Pi retries transient HTTP errors within a single prompt,
		 *  but a sustained provider hiccup can still exhaust those in-call
		 *  retries mid-session. Re-running the whole session a few times on
		 *  the same model avoids flapping to a different model (and losing
		 *  model-specific context) on the first hard failure. Applies to task
		 *  execution, commit/review follow-up sessions, and review-fix
		 *  re-execution alike. After this many attempts on one model, ralpi
		 *  advances to the next model in the round-robin pool. */
		maxSameModelAttempts: number;
		/** Isolate each task in a separate git worktree so parallel tasks can't
		 *  stomp each other's files, and review/commit see a clean single-task diff.
		 *  - "never":   all tasks run in the shared working tree (default, backward compat)
		 *  - "parallel": only when maxParallel > 1 and mode is parallel
		 *  - "always":  every task gets its own worktree */
		worktrees: "always" | "parallel" | "never";
		/** Chat rendering style for tool calls during task execution.
		 *  - "compact": single completion message per task with an expandable
		 *    tool-call tree (collapsed shows last 3, expanded shows all).
		 *  - "verbose": per-event stream — each tool start/end and assistant
		 *    turn is its own chat line (piolium/pygienium-style). */
		chatStyle: "compact" | "verbose";
	};
	prompts: {
		/** Additional context injected into every task prompt */
		projectContext: string;
		/** Custom prompt suffix for reflection extraction */
		reflectionPrompt: string;
		/** Per-review custom focus/instructions (e.g. "check security only").
		 *  Injected as a `### Custom Review Focus` section in committed and
		 *  uncommitted review prompts when non-empty. */
		reviewFocus: string;
	};
	review: {
		/** Extra noise-filter exclusion regexes (strings compiled to RegExp),
		 *  merged into EXCLUDED_PATTERNS for review diffs. */
		extraIgnorePatterns: string[];
		/** Pathspec allowlist — files matching these stay in scope even when a
		 *  default noise rule would exclude them. */
		ignorePaths: string[];
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
		reviewsDir: ".ralpi/reviews",
	},
	execution: {
		timeoutMs: 0, // 0 = inherit Pi's own defaults (no ralpi-level timeout)
		maxParallel: 3,
		models: [],
		autoCommit: true,
		autoReview: false,
		saveReviews: false,
		commitModel: "",
		reviewModel: "",
		implModel: "",
		commitTimeoutMs: 0, // 0 = inherit Pi's own defaults (no ralpi-level timeout)
		reviewTimeoutMs: 0, // 0 = inherit Pi's own defaults (no ralpi-level timeout)
		maxReviewRetries: 2, // 2 re-execution attempts on review rejection before giving up
		reviewBlockOnFail: false, // false = commit anyway after retries exhausted
		loopTimeoutMs: 0, // 0 = no limit
		worktrees: "parallel", // worktree isolation for parallel tasks by default
		maxSameModelAttempts: 5, // retry the same model up to 5 times before cycling to the next
		chatStyle: "compact", // compact = completion message with tool-call tree; verbose = per-event stream
	},
	prompts: {
		projectContext: "",
		reflectionPrompt: "",
		reviewFocus: "",
	},
	review: {
		extraIgnorePatterns: [],
		ignorePaths: [],
	},
};
