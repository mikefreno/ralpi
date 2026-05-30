import type { Task, ExecutionBatch, ExecutionPlan, Project } from "./types";

// ─── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Build an execution plan from project tasks using DAG analysis.
 * Returns ordered batches of parallelizable tasks.
 */
export function buildExecutionPlan(
  project: Project,
  completed: Set<string>,
  parallelGroup?: number,
): ExecutionPlan {
  const allTasks = new Map(project.tasks.map(t => [t.id, t]));

  // Filter out already completed tasks
  const pendingTasks = project.tasks.filter(t => !completed.has(t.id));

  // If parallel_group is explicitly set, use group-based batching
  if (parallelGroup !== undefined) {
    return {
      batches: buildParallelGroupBatches(pendingTasks, allTasks, completed),
      totalTasks: pendingTasks.length,
      skippedTasks: project.tasks.filter(t => completed.has(t.id)),
    };
  }

  // Use dependency-based Kahn's algorithm
  return {
    batches: buildBatches(pendingTasks, allTasks, completed),
    totalTasks: pendingTasks.length,
    skippedTasks: project.tasks.filter(t => completed.has(t.id)),
  };
}

// ─── Sequential Plan ─────────────────────────────────────────────────────────

/**
 * Build a sequential execution plan (one task per batch)
 */
export function buildSequentialPlan(
  project: Project,
  completed: Set<string>,
): ExecutionPlan {
  const pendingTasks = project.tasks.filter(t => !completed.has(t.id));
  const batches: ExecutionBatch[] = pendingTasks.map((task, i) => ({
    tasks: [task],
    batchIndex: i,
  }));

  return {
    batches,
    totalTasks: pendingTasks.length,
    skippedTasks: project.tasks.filter(t => completed.has(t.id)),
  };
}

// ─── Kahn's Algorithm (Dependency-Based Batching) ────────────────────────────

function buildBatches(
  pendingTasks: Task[],
  allTasks: Map<string, Task>,
  completed: Set<string>,
): ExecutionBatch[] {
  const batches: ExecutionBatch[] = [];
  const done = new Set(completed);
  const remaining = new Set(pendingTasks.map(t => t.id));

  while (remaining.size > 0) {
    // Find tasks whose dependencies are all satisfied
    const ready: Task[] = [];
    for (const task of pendingTasks) {
      if (!remaining.has(task.id)) continue;

      const deps = task.dependencies || [];
      const depsSatisfied = deps.every(
        dep => done.has(dep) || !allTasks.has(dep)
      );

      if (depsSatisfied) {
        ready.push(task);
      }
    }

    // Cycle detection: no tasks ready but some remain
    if (ready.length === 0) {
      const cycleTasks = Array.from(remaining);
      throw new Error(
        `Dependency cycle detected among tasks: ${cycleTasks.join(", ")}`
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

// ─── Parallel Group Batching ─────────────────────────────────────────────────

/**
 * Build batches from explicit parallel_group values.
 * Groups execute in ascending order; tasks within a group run concurrently.
 */
function buildParallelGroupBatches(
  pendingTasks: Task[],
  allTasks: Map<string, Task>,
  completed: Set<string>,
): ExecutionBatch[] {
  const groups = new Map<number, Task[]>();

  for (const task of pendingTasks) {
    const group = task.parallelGroup ?? 0;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(task);
  }

  const sortedGroups = Array.from(groups.entries()).sort(
    (a, b) => a[0] - b[0]
  );

  return sortedGroups.map(([groupNum, tasks], i) => ({
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
  return project.tasks.filter(task => {
    if (completed.has(task.id)) return false;
    const deps = task.dependencies || [];
    return deps.every(dep => completed.has(dep));
  });
}

// ─── Critical Path ───────────────────────────────────────────────────────────

/**
 * Calculate the critical path (longest path through the DAG)
 */
export function getCriticalPath(project: Project): Task[] {
  const taskMap = new Map(project.tasks.map(t => [t.id, t]));
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
      const depTask = taskMap.get(dep);
      if (!depTask) continue;

      const newDist = dist.get(dep) + 1;
      if (newDist > dist.get(task.id)!) {
        dist.set(task.id, newDist);
        prev.set(task.id, dep);
      }
    }
  }

  // Trace back from the longest path end
  let maxTask = project.tasks[0];
  for (const task of project.tasks) {
    if (dist.get(task.id) > dist.get(maxTask.id)) {
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

// ─── Format Execution Plan ───────────────────────────────────────────────────

/**
 * Format the execution plan for display
 */
export function formatExecutionPlan(plan: ExecutionPlan): string {
  const lines: string[] = [];
  lines.push("## Execution Plan");
  lines.push("");
  lines.push(`Total tasks: ${plan.totalTasks}`);
  lines.push(`Batches: ${plan.batches.length}`);

  if (plan.skippedTasks.length > 0) {
    lines.push(`Already completed: ${plan.skippedTasks.map(t => t.id).join(", ")}`);
  }
  lines.push("");

  for (const batch of plan.batches) {
    lines.push(`### Batch ${batch.batchIndex + 1}`);
    for (const task of batch.tasks) {
      lines.push(`- ${task.id}: ${task.title}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
