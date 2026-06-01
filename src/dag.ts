import type {
	Task,
	ExecutionBatch,
	ExecutionPlan,
	Project,
	ParallelGroup,
} from "./types";

// ─── Blocked Tasks ───────────────────────────────────────────────────────────

/**
 * Find tasks that are blocked (direct or transitive) due to failed dependencies.
 * Returns a Set of blocked task IDs.
 */
export function getBlockedTasks(
	pendingTasks: Task[],
	failedTaskIds: Set<string>,
): Set<string> {
	const blocked = new Set<string>();

	let changed = true;
	while (changed) {
		changed = false;
		for (const task of pendingTasks) {
			if (blocked.has(task.id)) continue;
			const deps = task.dependencies || [];
			if (deps.some((dep) => failedTaskIds.has(dep))) {
				blocked.add(task.id);
				changed = true;
			}
		}
	}

	return blocked;
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Build an execution plan from project tasks using DAG analysis.
 * Returns ordered batches of parallelizable tasks.
 */
export function buildExecutionPlan(
	project: Project,
	completed: Set<string>,
	parallelGroup?: number,
	failedTaskIds: Set<string> = new Set(),
): ExecutionPlan {
	// Filter out already completed tasks
	const pendingTasks = project.tasks.filter((t) => !completed.has(t.id));
	const skippedTasks = project.tasks.filter((t) => completed.has(t.id));

	// With explicitly declared parallel groups, all groups are independent.
	// Since there are no cross-group dependencies by definition, standard
	// Kahn's algorithm produces the correct plan — tasks ready in any group
	// appear in the same batch, and intra-group dependencies (e.g. "21 must
	// be done before 22, 23, 24") are respected automatically.
	// The parallel groups are preserved as metadata for display/documentation.
	if (project.parallelGroups && project.parallelGroups.length > 0) {
		return {
			batches: buildGroupAwareBatches(project, pendingTasks, failedTaskIds),
			totalTasks: pendingTasks.length,
			skippedTasks,
		};
	}

	// If parallel_group is explicitly set (legacy config flag), use group-based batching
	if (parallelGroup !== undefined) {
		return {
			batches: buildParallelGroupBatchesLegacy(pendingTasks, failedTaskIds),
			totalTasks: pendingTasks.length,
			skippedTasks,
		};
	}

	// Use dependency-based Kahn's algorithm
	return {
		batches: buildBatches(pendingTasks, failedTaskIds),
		totalTasks: pendingTasks.length,
		skippedTasks,
	};
}

// ─── Sequential Plan ─────────────────────────────────────────────────────────

/**
 * Build a sequential execution plan (one task per batch)
 */
export function buildSequentialPlan(
	project: Project,
	completed: Set<string>,
	failedTaskIds: Set<string> = new Set(),
): ExecutionPlan {
	const pendingTasks = project.tasks.filter((t) => !completed.has(t.id));

	// Mark tasks with failed dependencies as skipped
	const blocked = getBlockedTasks(pendingTasks, failedTaskIds);
	const skippedTasks = project.tasks.filter(
		(t) => completed.has(t.id) || blocked.has(t.id),
	);
	const activeTasks = pendingTasks.filter((t) => !blocked.has(t.id));

	const batches: ExecutionBatch[] = activeTasks.map((task, i) => ({
		tasks: [task],
		batchIndex: i,
	}));

	return {
		batches,
		totalTasks: pendingTasks.length,
		skippedTasks,
	};
}

// ─── Kahn's Algorithm (Dependency-Based Batching) ────────────────────────────

function buildBatches(
	pendingTasks: Task[],
	failedTaskIds: Set<string>,
): ExecutionBatch[] {
	const batches: ExecutionBatch[] = [];
	const done = new Set<string>();
	const blocked = getBlockedTasks(pendingTasks, failedTaskIds);
	const pendingSet = new Set(pendingTasks.map((t) => t.id));
	const remaining = new Set(
		pendingTasks.filter((t) => !blocked.has(t.id)).map((t) => t.id),
	);

	while (remaining.size > 0) {
		// Find tasks whose dependencies are all satisfied
		const ready: Task[] = [];
		for (const task of pendingTasks) {
			if (!remaining.has(task.id)) continue;

			const deps = task.dependencies || [];
			const depsSatisfied = deps.every(
				(dep) => done.has(dep) || !pendingSet.has(dep),
			);

			if (depsSatisfied) {
				ready.push(task);
			}
		}

		// Cycle detection: no tasks ready but some remain
		if (ready.length === 0) {
			const cycleTasks = Array.from(remaining);
			throw new Error(
				`Dependency cycle detected among tasks: ${cycleTasks.join(", ")}`,
			);
		}

		batches.push({ tasks: ready, batchIndex: batches.length });
		for (const task of ready) {
			done.add(task.id);
			remaining.delete(task.id);
		}
	}

	return batches;
}

// ─── Group-Aware Batching ────────────────────────────────────────────────────

/**
 * Build batches respecting both explicit parallel groups and intra-group
 * dependencies. Since parallel group declarations imply no cross-group
 * dependencies, all tasks whose dependencies are satisfied — across any
 * group — can run concurrently in the same batch. This means groups
 * "proceed independently" as the user specified: tasks from different
 * groups can appear in the same batch when ready.
 *
 * Intra-group dependencies (e.g., "21 must be done before 22, 23, 24")
 * are handled by Kahn's algorithm: if 21 has deps satisfied but 22 doesn't,
 * only 21 appears in the current batch.
 */
function buildGroupAwareBatches(
	_project: Project,
	pendingTasks: Task[],
	failedTaskIds: Set<string>,
): ExecutionBatch[] {
	const blocked = getBlockedTasks(pendingTasks, failedTaskIds);
	const activeTasks = pendingTasks.filter((t) => !blocked.has(t.id));

	// Standard Kahn's algorithm across ALL tasks — parallel groups are
	// metadata for display, not scheduling constraints.
	const pendingSet = new Set(pendingTasks.map((t) => t.id));
	const done = new Set<string>();
	const remaining = new Set(activeTasks.map((t) => t.id));
	const batches: ExecutionBatch[] = [];

	while (remaining.size > 0) {
		const ready: Task[] = [];
		for (const task of activeTasks) {
			if (!remaining.has(task.id)) continue;
			const deps = task.dependencies || [];
			const depsSatisfied = deps.every(
				(dep) => done.has(dep) || !pendingSet.has(dep),
			);
			if (depsSatisfied) {
				ready.push(task);
			}
		}

		if (ready.length === 0) {
			throw new Error(
				`Dependency cycle detected: ${Array.from(remaining).join(", ")}`,
			);
		}

		batches.push({ tasks: ready, batchIndex: batches.length });
		for (const task of ready) {
			done.add(task.id);
			remaining.delete(task.id);
		}
	}

	return batches;
}

// ─── Legacy Parallel Group Batching ─────────────────────────────────────────

/**
 * Legacy: build batches from explicit parallel_group values only.
 * Groups execute in ascending order; tasks within a group run concurrently.
 * Does NOT respect intra-group dependencies.
 */
function buildParallelGroupBatchesLegacy(
	pendingTasks: Task[],
	failedTaskIds: Set<string>,
): ExecutionBatch[] {
	const blocked = getBlockedTasks(pendingTasks, failedTaskIds);
	const activeTasks = pendingTasks.filter((t) => !blocked.has(t.id));

	const groups = new Map<number, Task[]>();

	for (const task of activeTasks) {
		const group = task.parallelGroup ?? 0;
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)!.push(task);
	}

	const sortedGroups = Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);

	return sortedGroups.map(([_groupNum, tasks], i) => ({
		tasks,
		batchIndex: i,
	}));
}

// ─── Cycle Detection ─────────────────────────────────────────────────────────

/**
 * Detect cycles in the task dependency graph
 */
export function detectCycles(project: Project): string[] {
	const adj = new Map<string, string[]>();
	for (const task of project.tasks) {
		adj.set(task.id, task.dependencies || []);
	}

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();

	for (const task of project.tasks) {
		color.set(task.id, WHITE);
	}

	const cycleNodes: string[] = [];

	function dfs(node: string): boolean {
		color.set(node, GRAY);
		const deps = adj.get(node) || [];

		for (const dep of deps) {
			if (!adj.has(dep)) continue;
			const depColor = color.get(dep);

			if (depColor === GRAY) {
				cycleNodes.push(dep);
				return true;
			}
			if (depColor === WHITE && dfs(dep)) {
				cycleNodes.push(node);
				return true;
			}
		}

		color.set(node, BLACK);
		return false;
	}

	for (const task of project.tasks) {
		if (color.get(task.id) === WHITE) {
			dfs(task.id);
		}
	}

	return [...new Set(cycleNodes)];
}

// ─── Ready Tasks ─────────────────────────────────────────────────────────────

/**
 * Get tasks that are ready to execute (all dependencies completed)
 */
export function getReadyTasks(
	project: Project,
	completed: Set<string>,
): Task[] {
	return project.tasks.filter((task) => {
		if (completed.has(task.id)) return false;
		const deps = task.dependencies || [];
		return deps.every((dep) => completed.has(dep));
	});
}

// ─── Critical Path ───────────────────────────────────────────────────────────

/**
 * Calculate the critical path (longest path through the DAG)
 */
export function getCriticalPath(project: Project): Task[] {
	const taskMap = new Map(project.tasks.map((t) => [t.id, t]));
	const dist = new Map<string, number>();
	const prev = new Map<string, string | null>();

	// Initialize
	for (const task of project.tasks) {
		dist.set(task.id, 1);
		prev.set(task.id, null);
	}

	// Topological sort
	const sorted: Task[] = [];
	const visited = new Set<string>();

	function visit(id: string) {
		if (visited.has(id)) return;
		visited.add(id);
		const task = taskMap.get(id);
		if (!task) return;

		for (const dep of task.dependencies || []) {
			visit(dep);
		}
		sorted.push(task);
	}

	for (const task of project.tasks) {
		visit(task.id);
	}

	// Relax edges
	for (const task of sorted) {
		for (const dep of task.dependencies || []) {
			const depDist = dist.get(dep);
			if (depDist === undefined) continue;

			const newDist = depDist + 1;
			const currentDist = dist.get(task.id) ?? 0;
			if (newDist > currentDist) {
				dist.set(task.id, newDist);
				prev.set(task.id, dep);
			}
		}
	}

	// Trace back from the longest path end
	let maxTask = project.tasks[0];
	for (const task of project.tasks) {
		const taskDist = dist.get(task.id) ?? 0;
		const maxDist = dist.get(maxTask.id) ?? 0;
		if (taskDist > maxDist) {
			maxTask = task;
		}
	}

	const path: Task[] = [];
	let current: string | null = maxTask.id;
	while (current) {
		const task = taskMap.get(current);
		if (task) path.unshift(task);
		current = prev.get(current) || null;
	}

	return path;
}

// ─── Format Dependency Chain ─────────────────────────────────────────────────

/**
 * Format the dependency DAG as a tree for display.
 * Rooted at tasks with no dependencies, showing what depends on what.
 */
export function formatDependencyChain(project: Project): string {
	const taskMap = new Map(project.tasks.map((t) => [t.id, t]));
	const lines: string[] = [];

	lines.push("## Dependency Chain");
	lines.push("");

	if (project.tasks.length === 0) {
		lines.push("(no tasks)");
		return lines.join("\n");
	}

	// Build reverse dependency map: taskId → [dependent taskIds]
	const dependents = new Map<string, string[]>();
	for (const task of project.tasks) {
		dependents.set(task.id, []);
	}
	for (const task of project.tasks) {
		for (const dep of task.dependencies) {
			if (dependents.has(dep)) {
				dependents.get(dep)!.push(task.id);
			}
		}
	}

	// Root tasks: those with no dependencies
	const roots = project.tasks.filter((t) => t.dependencies.length === 0);
	const rendered = new Set<string>();

	function renderNode(taskId: string, prefix: string, isLast: boolean): void {
		const task = taskMap.get(taskId);
		if (!task) return;

		const alreadyRendered = rendered.has(taskId);
		rendered.add(taskId);

		const connector = prefix ? (isLast ? "└── " : "├── ") : "";

		if (alreadyRendered) {
			lines.push(`${prefix}${connector}${task.id} · ${task.title}`);
			return;
		}

		const deps =
			task.dependencies.length > 0
				? ` ← needs ${task.dependencies.join(", ")}`
				: " (root)";

		lines.push(
			`${prefix}${connector}${task.id} · ${task.title}${prefix ? "" : deps}`,
		);

		const children = (dependents.get(taskId) || [])
			.filter((c) => c !== taskId)
			.sort();

		for (let i = 0; i < children.length; i++) {
			const childPrefix = prefix + (isLast ? "    " : "│   ");
			renderNode(children[i], childPrefix, i === children.length - 1);
		}
	}

	for (let i = 0; i < roots.length; i++) {
		renderNode(roots[i].id, "", i === roots.length - 1);
	}

	// Tasks not reached from any root (have deps but no root-traversable path)
	const unreached = project.tasks.filter((t) => !rendered.has(t.id));
	if (unreached.length > 0) {
		lines.push("");
		lines.push("Orphan tasks (dependencies not in task list):");
		for (const t of unreached) {
			const deps =
				t.dependencies.length > 0
					? ` ← needs ${t.dependencies.join(", ")}`
					: "";
			lines.push(`  ${t.id} · ${t.title}${deps}`);
		}
	}

	return lines.join("\n");
}

// ─── Format Execution Plan ───────────────────────────────────────────────────

/**
 * Format the execution plan for display
 */
/**
 * Format the execution plan for display, optionally with parallel group annotations
 */
export function formatExecutionPlan(
	plan: ExecutionPlan,
	parallelGroups?: ParallelGroup[],
): string {
	const lines: string[] = [];
	lines.push("## Execution Plan");
	lines.push("");
	lines.push(`Total tasks: ${plan.totalTasks}`);
	lines.push(`Batches: ${plan.batches.length}`);

	// Build a lookup: taskId → group label
	const groupLabel = new Map<string, string>();
	if (parallelGroups) {
		for (const g of parallelGroups) {
			for (const id of g.taskIds) {
				if (g.label) {
					groupLabel.set(id, g.label);
				}
			}
		}
	}

	if (plan.skippedTasks.length > 0) {
		lines.push(
			`Already completed: ${plan.skippedTasks.map((t) => t.id).join(", ")}`,
		);
	}
	lines.push("");

	for (const batch of plan.batches) {
		lines.push(`### Batch ${batch.batchIndex + 1}`);
		for (const task of batch.tasks) {
			const annotation = groupLabel.has(task.id)
				? `  _(${groupLabel.get(task.id)})_`
				: "";
			const deps =
				task.dependencies.length > 0
					? `  ← needs ${task.dependencies.join(", ")}`
					: "";
			lines.push(`- ${task.id}: ${task.title}${annotation}${deps}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
