/// <reference types="bun-types" />
import { describe, it, expect } from "bun:test";
import type { Project, Task } from "../src/types";
import {
	buildExecutionPlan,
	buildSequentialPlan,
	getBlockedTasks,
	detectCycles,
	getCriticalPath,
	formatDependencyChain,
	formatExecutionPlan,
} from "../src/dag";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProject(overrides?: Partial<Project>): Project {
	return {
		tasks: [],
		dependencies: {},
		sourcePath: "/tmp/test.md",
		sourceDir: "/tmp",
		...overrides,
	};
}

function task(
	id: string,
	dependencies: string[] = [],
	status: Task["status"] = "pending",
	parallelGroup?: number,
): Task {
	return { id, title: `Task ${id}`, status, dependencies, parallelGroup };
}

function tasksFrom(...args: Task[]): Task[] {
	return args;
}

// ─── Basic DAG Construction ──────────────────────────────────────────────────

describe("buildExecutionPlan (Kahn's algorithm)", () => {
	it("handles empty task list", () => {
		const project = makeProject({ tasks: [] });
		const plan = buildExecutionPlan(project, new Set());
		expect(plan.batches).toEqual([]);
		expect(plan.totalTasks).toBe(0);
	});

	it("puts all root tasks in batch 0", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02"), task("03")),
		});
		const plan = buildExecutionPlan(project, new Set());
		expect(plan.batches).toHaveLength(1);
		expect(plan.batches[0].tasks.map((t) => t.id).sort()).toEqual([
			"01",
			"02",
			"03",
		]);
	});

	it("builds correct linear dependency chain", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["02"]),
				task("04", ["03"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set());
		expect(plan.batches).toHaveLength(4);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[1].tasks.map((t) => t.id)).toEqual(["02"]);
		expect(plan.batches[2].tasks.map((t) => t.id)).toEqual(["03"]);
		expect(plan.batches[3].tasks.map((t) => t.id)).toEqual(["04"]);
	});

	it("groups parallelizable tasks in the same batch", () => {
		// Diamond: 01 -> 02, 03 -> 04
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04", ["02", "03"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set());
		// Batch 0: [01], Batch 1: [02, 03], Batch 2: [04]
		expect(plan.batches).toHaveLength(3);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[1].tasks.map((t) => t.id).sort()).toEqual(["02", "03"]);
		expect(plan.batches[2].tasks.map((t) => t.id)).toEqual(["04"]);
	});

	it("assigns correct batchIndex values", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04", ["02", "03"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set());
		expect(plan.batches[0].batchIndex).toBe(0);
		expect(plan.batches[1].batchIndex).toBe(1);
		expect(plan.batches[2].batchIndex).toBe(2);
	});

	it("skips completed tasks and includes them in skippedTasks", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01", [], "completed"),
				task("02", ["01"]),
				task("03", ["02"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set(["01"]));
		expect(plan.totalTasks).toBe(2);
		expect(plan.skippedTasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches).toHaveLength(2);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["02"]);
		expect(plan.batches[1].tasks.map((t) => t.id)).toEqual(["03"]);
	});

	it("throws on dependency cycle", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01", ["03"]),
				task("02", ["01"]),
				task("03", ["02"]),
			),
		});
		expect(() => buildExecutionPlan(project, new Set())).toThrow(
			/dependency cycle/i,
		);
	});

	it("blocks tasks that depend on failed tasks", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["02"]),
				task("04", ["03"]),
			),
		});
		const plan = buildExecutionPlan(
			project,
			new Set(),
			undefined,
			new Set(["01"]),
		);
		// 01 is excluded from pending (failed). 02, 03, 04 are pending but
		// transitively blocked — they don't appear in batches.
		expect(plan.skippedTasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.totalTasks).toBe(3); // 02, 03, 04 are pending but blocked
		expect(plan.batches).toHaveLength(0);
	});

	it("blocks immediate dependents when task fails", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04"), // independent
			),
		});
		const plan = buildExecutionPlan(
			project,
			new Set(),
			undefined,
			new Set(["01"]),
		);
		// 01 is excluded from pending (failed). 02, 03 are pending but blocked
		// (depend on 01). 04 is independent and ready.
		expect(plan.skippedTasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["04"]);
	});
});

// ─── Complex DAGs ───────────────────────────────────────────────────────────

describe("Complex DAG batching", () => {
	it("builds the OAuth PRD example correctly", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["02"]),
				task("04", ["01"]),
				task("05", ["03", "04"]),
				task("06", ["03", "04"]),
				task("07", ["03"]),
				task("08", ["05", "06", "07"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set());
		// Expected batches: [01], [02,04], [03], [05,06,07], [08]
		expect(plan.batches).toHaveLength(5);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[1].tasks.map((t) => t.id).sort()).toEqual(["02", "04"]);
		expect(plan.batches[2].tasks.map((t) => t.id)).toEqual(["03"]);
		expect(plan.batches[3].tasks.map((t) => t.id).sort()).toEqual([
			"05",
			"06",
			"07",
		]);
		expect(plan.batches[4].tasks.map((t) => t.id)).toEqual(["08"]);
	});

	it("builds the Design Token PRD example correctly", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04", ["02", "03"]),
				task("05", ["04", "01"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set());
		// Expected batches: [01], [02,03], [04], [05]
		expect(plan.batches).toHaveLength(4);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[1].tasks.map((t) => t.id).sort()).toEqual(["02", "03"]);
		expect(plan.batches[2].tasks.map((t) => t.id)).toEqual(["04"]);
		expect(plan.batches[3].tasks.map((t) => t.id)).toEqual(["05"]);
	});

	it("handles a 3-tier diamond", () => {
		//      01
		//     /  \
		//    02  03
		//   / \ / \
		//  04 05 06
		//   \ | /
		//    07
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04", ["02"]),
				task("05", ["02", "03"]),
				task("06", ["03"]),
				task("07", ["04", "05", "06"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set());
		expect(plan.batches).toHaveLength(4);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[1].tasks.map((t) => t.id).sort()).toEqual(["02", "03"]);
		expect(plan.batches[2].tasks.map((t) => t.id).sort()).toEqual([
			"04",
			"05",
			"06",
		]);
		expect(plan.batches[3].tasks.map((t) => t.id)).toEqual(["07"]);
	});

	it("handles a wide fan-out with delayed convergence", () => {
		// 01 -> 02,03,04,05,06
		// 02,03 -> 07
		// 04,05 -> 08
		// 06 -> 09
		// 07,08,09 -> 10
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04", ["01"]),
				task("05", ["01"]),
				task("06", ["01"]),
				task("07", ["02", "03"]),
				task("08", ["04", "05"]),
				task("09", ["06"]),
				task("10", ["07", "08", "09"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set());
		expect(plan.batches).toHaveLength(4);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[1].tasks.map((t) => t.id).sort()).toEqual([
			"02",
			"03",
			"04",
			"05",
			"06",
		]);
		expect(plan.batches[2].tasks.map((t) => t.id).sort()).toEqual([
			"07",
			"08",
			"09",
		]);
		expect(plan.batches[3].tasks.map((t) => t.id)).toEqual(["10"]);
	});

	it("handles multiple independent subgraphs", () => {
		// Two completely independent chains:
		// Chain A: 01 -> 02 -> 03
		// Chain B: 04 -> 05
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["02"]),
				task("04"),
				task("05", ["04"]),
			),
		});
		const plan = buildExecutionPlan(project, new Set());
		// Batch 0: [01, 04] (both roots)
		// Batch 1: [02, 05]
		// Batch 2: [03]
		expect(plan.batches[0].tasks.map((t) => t.id).sort()).toEqual(["01", "04"]);
		expect(plan.batches[1].tasks.map((t) => t.id).sort()).toEqual(["02", "05"]);
		expect(plan.batches[2].tasks.map((t) => t.id)).toEqual(["03"]);
	});

	it("batches tasks respecting fan-in convergence", () => {
		// 01 -> 03, 02 -> 03 (03 depends on both 01 AND 02)
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02"), task("03", ["01", "02"])),
		});
		const plan = buildExecutionPlan(project, new Set());
		expect(plan.batches[0].tasks.map((t) => t.id).sort()).toEqual(["01", "02"]);
		expect(plan.batches[1].tasks.map((t) => t.id)).toEqual(["03"]);
	});
});

// ─── Sequential Plan ─────────────────────────────────────────────────────────

describe("buildSequentialPlan", () => {
	it("puts each task in its own batch", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02", ["01"]), task("03", ["01"])),
		});
		const plan = buildSequentialPlan(project, new Set());
		expect(plan.batches).toHaveLength(3);
		plan.batches.forEach((b, i) => {
			expect(b.tasks).toHaveLength(1);
			expect(b.batchIndex).toBe(i);
		});
	});

	it("skips completed tasks and blocks transitively failed tasks", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["02"]),
				task("04"),
			),
		});
		const plan = buildSequentialPlan(project, new Set(["01"]), new Set(["01"]));
		// 01 failed => 02, 03 blocked. 04 independent, runs.
		expect(plan.skippedTasks.map((t) => t.id).sort()).toEqual([
			"01",
			"02",
			"03",
		]);
		expect(plan.totalTasks).toBe(3);
	});

	it("maintains task order in sequential batches", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02", ["01"]), task("03", ["01"])),
		});
		const plan = buildSequentialPlan(project, new Set());
		expect(plan.batches.map((b) => b.tasks[0].id)).toEqual(["01", "02", "03"]);
	});
});

// ─── getBlockedTasks ─────────────────────────────────────────────────────────

describe("getBlockedTasks", () => {
	it("returns direct dependents of failed tasks", () => {
		const pending = tasksFrom(task("01"), task("02", ["01"]), task("03"));
		const blocked = getBlockedTasks(pending, new Set(["01"]));
		expect([...blocked]).toEqual(["02"]);
	});

	it("returns transitive dependents (chain reaction)", () => {
		const pending = tasksFrom(
			task("01"),
			task("02", ["01"]),
			task("03", ["02"]),
			task("04", ["03"]),
		);
		const blocked = getBlockedTasks(pending, new Set(["01"]));
		expect([...blocked].sort()).toEqual(["02", "03", "04"]);
	});

	it("does not affect tasks in separate subgraphs", () => {
		const pending = tasksFrom(
			task("01"),
			task("02", ["01"]),
			task("10"),
			task("11", ["10"]),
		);
		const blocked = getBlockedTasks(pending, new Set(["01"]));
		expect([...blocked].sort()).toEqual(["02"]);
	});

	it("returns empty set when no tasks depend on failed tasks", () => {
		const pending = tasksFrom(task("01"), task("02"), task("03"));
		const blocked = getBlockedTasks(pending, new Set(["99"]));
		expect(blocked.size).toBe(0);
	});
});

// ─── detectCycles ────────────────────────────────────────────────────────────

describe("detectCycles", () => {
	it("returns empty for acyclic graph", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02", ["01"]), task("03", ["02"])),
		});
		expect(detectCycles(project)).toEqual([]);
	});

	it("detects a 3-node cycle", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01", ["03"]),
				task("02", ["01"]),
				task("03", ["02"]),
			),
		});
		const cycles = detectCycles(project);
		expect(cycles.length).toBeGreaterThan(0);
	});

	it("detects a self-loop", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01", ["01"])),
		});
		const cycles = detectCycles(project);
		expect(cycles.length).toBeGreaterThan(0);
	});

	it("detects cycle in disconnected subgraph", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"), // isolated
				task("02", ["03"]),
				task("03", ["02"]), // cycle
			),
		});
		const cycles = detectCycles(project);
		expect(cycles.length).toBeGreaterThan(0);
	});

	it("returns empty for graph with only diamond patterns", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04", ["02", "03"]),
			),
		});
		expect(detectCycles(project)).toEqual([]);
	});
});

// ─── getCriticalPath ─────────────────────────────────────────────────────────

describe("getCriticalPath", () => {
	it("returns the longest path through the DAG", () => {
		// 01 -> 02 -> 03 -> 04  (long = 4)
		// 01 -> 05 -> 04        (short = 3)
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["02"]),
				task("04", ["03", "05"]),
				task("05", ["01"]),
			),
		});
		const path = getCriticalPath(project);
		expect(path.length).toBe(4);
		expect(path[0].id).toBe("01");
		expect(path[path.length - 1].id).toBe("04");
	});

	it("returns single-node path for roots", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02"), task("03")),
		});
		const path = getCriticalPath(project);
		expect(path.length).toBe(1);
	});

	it("handles complex branching by picking the longest chain", () => {
		// 01 -> 02 -> 03 -> 04 -> 05  (long = 5)
		// 01 -> 06 -> 05               (short = 3)
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["02"]),
				task("04", ["03"]),
				task("05", ["04", "06"]),
				task("06", ["01"]),
			),
		});
		const path = getCriticalPath(project);
		// Should pick 01 -> 02 -> 03 -> 04 -> 05 (length 5)
		expect(path.length).toBe(5);
		expect(path.map((t) => t.id)).toEqual(["01", "02", "03", "04", "05"]);
	});
});

// ─── formatDependencyChain ───────────────────────────────────────────────────

describe("formatDependencyChain", () => {
	it("renders a simple tree", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02", ["01"])),
		});
		const formatted = formatDependencyChain(project);
		expect(formatted).toContain("01");
		expect(formatted).toContain("02");
	});

	it("mentions root tasks", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02")),
		});
		const formatted = formatDependencyChain(project);
		expect(formatted).toMatch(/01.*root|root.*01/i);
	});

	it("handles empty task list", () => {
		const project = makeProject({ tasks: [] });
		const formatted = formatDependencyChain(project);
		expect(formatted).toContain("no tasks");
	});

	it("shows orphan tasks when dependencies reference non-existent IDs", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01", ["99"])),
		});
		const formatted = formatDependencyChain(project);
		expect(formatted).toMatch(/orphan|unreached/i);
	});
});

// ─── formatExecutionPlan ─────────────────────────────────────────────────────

describe("formatExecutionPlan", () => {
	it("displays task counts and batches", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02", ["01"])),
		});
		const plan = buildExecutionPlan(project, new Set());
		const formatted = formatExecutionPlan(plan);
		expect(formatted).toContain("Total tasks");
		expect(formatted).toContain("Batches");
		expect(formatted).toContain("01");
		expect(formatted).toContain("02");
	});

	it("shows skipped tasks", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01", [], "completed"), task("02", ["01"])),
		});
		const plan = buildExecutionPlan(project, new Set(["01"]));
		const formatted = formatExecutionPlan(plan);
		expect(formatted).toContain("completed");
	});

	it("shows parallel group annotations when provided", () => {
		const project = makeProject({
			tasks: tasksFrom(task("01"), task("02", ["01"]), task("03", ["01"])),
			parallelGroups: [{ index: 0, label: "UI sprint", taskIds: ["02", "03"] }],
		});
		const plan = buildExecutionPlan(project, new Set());
		const formatted = formatExecutionPlan(plan, project.parallelGroups);
		expect(formatted).toContain("UI sprint");
	});
});

// ─── Group-Aware Batching ────────────────────────────────────────────────────

describe("Parallel group batching", () => {
	it("builds batches when parallel groups are defined", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04", ["02", "03"]),
			),
			parallelGroups: [
				{ index: 0, label: "Frontend", taskIds: ["01", "02", "03", "04"] },
			],
		});
		// Should route through buildGroupAwareBatches
		const plan = buildExecutionPlan(project, new Set());
		expect(plan.batches.length).toBeGreaterThan(0);
	});

	it("respects intra-group dependencies in parallel groups", () => {
		// Tasks: 01 -> 02, 01 -> 03, 02 -> 04, 03 -> 04
		// With parallel groups, there are no cross-group dependencies by definition.
		// Intra-group deps are respected by Kahn's algorithm.
		const project = makeProject({
			tasks: tasksFrom(
				task("01"),
				task("02", ["01"]),
				task("03", ["01"]),
				task("04", ["02", "03"]),
			),
			parallelGroups: [
				{ index: 0, label: "All", taskIds: ["01", "02", "03", "04"] },
			],
		});
		const plan = buildExecutionPlan(project, new Set());
		// Batch 0: [01], Batch 1: [02, 03], Batch 2: [04]
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[1].tasks.map((t) => t.id).sort()).toEqual(["02", "03"]);
		expect(plan.batches[2].tasks.map((t) => t.id)).toEqual(["04"]);
	});
});

// ─── Real-World Scenario: Resume with completed tasks ───────────────────────

describe("Real-world resume scenarios", () => {
	it("buildExecutionPlan correctly excludes file-based [x] completions", () => {
		// Design Token PRD resume: 01,02,03 [x] in file, 04 [~], 05 [ ]
		const project = makeProject({
			tasks: tasksFrom(
				task("01", [], "completed"),
				task("02", ["01"], "completed"),
				task("03", ["01"], "completed"),
				task("04", ["02", "03"], "in_progress"),
				task("05", ["04", "01"], "pending"),
			),
		});
		// buildCompletedSet in index.ts produces {01, 02, 03} from file + progress
		// This simulates what happens after buildCompletedSet is called
		const completedFromFile = new Set(
			project.tasks.filter((t) => t.status === "completed").map((t) => t.id),
		);
		const plan = buildExecutionPlan(project, completedFromFile);

		// Only 04 and 05 should be pending
		expect(plan.totalTasks).toBe(2);
		expect(plan.batches).toHaveLength(2);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["04"]);
		expect(plan.batches[1].tasks.map((t) => t.id)).toEqual(["05"]);
	});

	it("skipsTasks includes both progress-completed and file-completed tasks", () => {
		const project = makeProject({
			tasks: tasksFrom(
				task("01", [], "completed"),
				task("02", ["01"], "pending"),
			),
		});
		// Simulate: 01 completed in file AND in progress
		const plan = buildExecutionPlan(project, new Set(["01"]));
		expect(plan.skippedTasks.map((t) => t.id)).toEqual(["01"]);
		expect(plan.batches[0].tasks.map((t) => t.id)).toEqual(["02"]);
	});
});
