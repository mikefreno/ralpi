/**
 * Comprehensive tests for ralpi's parser (dependency formats) and DAG construction.
 *
 * Run: bun test tests/parser-dag.test.ts
 *
 * Covers all supported dependency declaration formats:
 *   - Arrow notation (->, →) — single, multi-target, multi-source, chained
 *   - Natural language "depends on" / "depend on" / "also depends on"
 *   - "must be done before" — single→multi, multi→single, multi→multi
 *   - "can be done in parallel" — with and without labels
 *   - Mixed formats in one file
 *   - DAG construction (Kahn's algorithm) — batching, cycle detection, critical path
 *   - buildCompletedSet integration
 *   - Blocked tasks (transitive)
 *   - Edge cases, negative tests
 */
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseTaskFile } from "../src/parser";
import {
	buildExecutionPlan,
	buildSequentialPlan,
	detectCycles,
	getBlockedTasks,
	getCriticalPath,
	getReadyTasks,
} from "../src/dag";
import type { Task, Project, ExecutionPlan } from "../src/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a markdown string as if it were a task file, returning the Project. */
function parseMD(content: string, name = "test-prd.md"): Project {
	const dir = fs.mkdtempSync("/tmp/ralpi-test-");
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, content, "utf-8");
	try {
		return parseTaskFile(filePath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Build an execution plan from a Project, marking specified IDs as completed. */
function plan(
	project: Project,
	completedIds: string[] = [],
	failedIds: string[] = [],
): ExecutionPlan {
	return buildExecutionPlan(
		project,
		new Set(completedIds),
		undefined,
		new Set(failedIds),
	);
}

/** Extract batch IDs for easy assertion: [[id1,id2], [id3], ...] */
function batchIds(plan: ExecutionPlan): string[][] {
	return plan.batches.map((b) => b.tasks.map((t) => t.id).sort());
}

/** Find a task by ID in a Project. */
function findTask(project: Project, id: string): Task {
	const t = project.tasks.find((t) => t.id === id);
	if (!t) throw new Error(`Task ${id} not found`);
	return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// ARROW NOTATION
// ─────────────────────────────────────────────────────────────────────────────

describe("Arrow notation (->)", () => {
	test("single arrow: 01 -> 02", () => {
		const md = `# Test
## Tasks
- [ ] 01 — task-a
- [ ] 02 — task-b
## Dependencies
01 -> 02`;
		const project = parseMD(md);
		expect(findTask(project, "01").dependencies).toEqual([]);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
	});

	test("multi-target: 01 -> 02,03,06", () => {
		const md = `# Test
## Tasks
- [ ] 01 — task-a
- [ ] 02 — task-b
- [ ] 03 — task-c
- [ ] 06 — task-f
## Dependencies
01 -> 02,03,06`;
		const project = parseMD(md);
		expect(findTask(project, "01").dependencies).toEqual([]);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
		expect(findTask(project, "03").dependencies).toEqual(["01"]);
		expect(findTask(project, "06").dependencies).toEqual(["01"]);
	});

	test("multi-source: 05,07,08 -> 13", () => {
		const md = `# Test
## Tasks
- [ ] 05 — task-e
- [ ] 07 — task-g
- [ ] 08 — task-h
- [ ] 13 — task-m
## Dependencies
05, 07, 08 -> 13`;
		const project = parseMD(md);
		expect(findTask(project, "13").dependencies).toEqual(["05", "07", "08"]);
	});

	test("chained: 03 -> 04 -> 05", () => {
		const md = `# Test
## Tasks
- [ ] 03 — task-c
- [ ] 04 — task-d
- [ ] 05 — task-e
## Dependencies
03 -> 04 -> 05`;
		const project = parseMD(md);
		expect(findTask(project, "04").dependencies).toEqual(["03"]);
		expect(findTask(project, "05").dependencies).toEqual(["04"]);
	});

	test("with markdown list prefix: - 01 -> 02,03", () => {
		const md = `# Test
## Tasks
- [ ] 01 — task-a
- [ ] 02 — task-b
- [ ] 03 — task-c
## Dependencies
- 01 -> 02,03`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
		expect(findTask(project, "03").dependencies).toEqual(["01"]);
	});

	test("unicode arrow (→): 01 → 02", () => {
		const md = `# Test
## Tasks
- [ ] 01 — task-a
- [ ] 02 — task-b
## Dependencies
01 → 02`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
	});

	test("chained with unicode arrows: A → B → C", () => {
		const md = `# Test
## Tasks
- [ ] 01 — setup
- [ ] 02 — build
- [ ] 03 — deploy
## Dependencies
01 → 02 → 03`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
		expect(findTask(project, "03").dependencies).toEqual(["02"]);
	});

	test("multi-source multi-target: 01,02 -> 03,04", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
- [ ] 04 — d
## Dependencies
01, 02 -> 03, 04`;
		const project = parseMD(md);
		expect(findTask(project, "03").dependencies).toEqual(["01", "02"]);
		expect(findTask(project, "04").dependencies).toEqual(["01", "02"]);
	});

	test("unpadded task IDs still pad to 2 digits", () => {
		const md = `# Test
## Tasks
- [ ] 1 — task-a
- [ ] 2 — task-b
- [ ] 3 — task-c
## Dependencies
1 -> 2, 3`;
		const project = parseMD(md);
		expect(findTask(project, "01").dependencies).toEqual([]);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
		expect(findTask(project, "03").dependencies).toEqual(["01"]);
	});

	test("arrow with parenthetical comment is stripped", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
- 01 -> 02, 03 (core dependency)`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
		expect(findTask(project, "03").dependencies).toEqual(["01"]);
	});

	test("non-numeric text after arrow is ignored", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
## Dependencies
01 -> some-text-here`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// NATURAL LANGUAGE "depends on"
// ─────────────────────────────────────────────────────────────────────────────

describe('Natural language "depends on"', () => {
	test("single task depends on single", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
## Dependencies
02 depends on 01`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
	});

	test("task depends on multiple: 13 depends on 17, 18, 19, 20", () => {
		const md = `# Test
## Tasks
- [ ] 13 — task-m
- [ ] 17 — task-q
- [ ] 18 — task-r
- [ ] 19 — task-s
- [ ] 20 — task-t
## Dependencies
13 depends on 17, 18, 19, 20`;
		const project = parseMD(md);
		expect(findTask(project, "13").dependencies).toEqual([
			"17",
			"18",
			"19",
			"20",
		]);
	});

	test('multiple tasks depend on one: "depend on" (plural)', () => {
		const md = `# Test
## Tasks
- [ ] 02 — b
- [ ] 03 — c
- [ ] 04 — d
- [ ] 05 — e
## Dependencies
04, 05 depend on 02, 03`;
		const project = parseMD(md);
		expect(findTask(project, "04").dependencies).toEqual(["02", "03"]);
		expect(findTask(project, "05").dependencies).toEqual(["02", "03"]);
	});

	test("also depends on", () => {
		const md = `# Test
## Tasks
- [ ] 05 — e
- [ ] 06 — f
- [ ] 08 — h
## Dependencies
08 also depends on 05, 06`;
		const project = parseMD(md);
		expect(findTask(project, "08").dependencies).toEqual(["05", "06"]);
	});

	test("with markdown list prefix", () => {
		const md = `# Test
## Tasks
- [ ] 13 — m
- [ ] 17 — q
- [ ] 18 — r
- [ ] 19 — s
## Dependencies
- 13 depends on 17, 18, 19`;
		const project = parseMD(md);
		expect(findTask(project, "13").dependencies).toEqual(["17", "18", "19"]);
	});

	test("with parenthetical description", () => {
		const md = `# Test
## Tasks
- [ ] 21 — setup-db
- [ ] 22 — write-queries
- [ ] 23 — build-api
## Dependencies
- 22 depends on 21 (database schema must exist)
- 23 depends on 22 (API builds on queries)`;
		const project = parseMD(md);
		expect(findTask(project, "22").dependencies).toEqual(["21"]);
		expect(findTask(project, "23").dependencies).toEqual(["22"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// "must be done before"
// ─────────────────────────────────────────────────────────────────────────────

describe('"must be done before"', () => {
	test("single must be done before multiple", () => {
		const md = `# Test
## Tasks
- [ ] 21 — backend-foundation
- [ ] 22 — api-endpoints
- [ ] 23 — database-migrations
- [ ] 24 — integration-tests
## Dependencies
21 must be done before 22, 23, 24`;
		const project = parseMD(md);
		expect(findTask(project, "21").dependencies).toEqual([]);
		expect(findTask(project, "22").dependencies).toEqual(["21"]);
		expect(findTask(project, "23").dependencies).toEqual(["21"]);
		expect(findTask(project, "24").dependencies).toEqual(["21"]);
	});

	test("multiple must be done before single", () => {
		const md = `# Test
## Tasks
- [ ] 02 — design
- [ ] 03 — review
- [ ] 04 — implement
## Dependencies
02, 03 must be done before 04`;
		const project = parseMD(md);
		expect(findTask(project, "04").dependencies).toEqual(["02", "03"]);
	});

	test("with markdown list prefix and parenthetical", () => {
		const md = `# Test
## Tasks
- [ ] 21 — backend
- [ ] 22 — api
- [ ] 23 — db
- [ ] 24 — tests
## Dependencies
- 21 must be done before 22, 23, 24 (backend integration foundation)`;
		const project = parseMD(md);
		expect(findTask(project, "22").dependencies).toEqual(["21"]);
		expect(findTask(project, "23").dependencies).toEqual(["21"]);
		expect(findTask(project, "24").dependencies).toEqual(["21"]);
	});

	test("multi must be done before multi", () => {
		const md = `# Test
## Tasks
- [ ] 01 — env
- [ ] 02 — config
- [ ] 03 — api-v1
- [ ] 04 — api-v2
## Dependencies
01, 02 must be done before 03, 04`;
		const project = parseMD(md);
		expect(findTask(project, "03").dependencies).toEqual(["01", "02"]);
		expect(findTask(project, "04").dependencies).toEqual(["01", "02"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// "can be done in parallel"
// ─────────────────────────────────────────────────────────────────────────────

describe('"can be done in parallel"', () => {
	test("basic parallel group without label", () => {
		const md = `# Test
## Tasks
- [ ] 02 — design
- [ ] 03 — auth
- [ ] 04 — storage
## Dependencies
02, 03, 04 can be done in parallel`;
		const project = parseMD(md);
		expect(project.parallelGroups).toBeDefined();
		expect(project.parallelGroups!.length).toBe(1);
		expect(project.parallelGroups![0].taskIds.sort()).toEqual([
			"02",
			"03",
			"04",
		]);
		expect(project.parallelGroups![0].label).toBeUndefined();
	});

	test("parallel group with label", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
- [ ] 04 — d
## Dependencies
01, 02, 03, 04 can be done in parallel (Play Store prep)`;
		const project = parseMD(md);
		expect(project.parallelGroups![0].label).toBe("Play Store prep");
		expect(project.parallelGroups![0].taskIds.sort()).toEqual([
			"01",
			"02",
			"03",
			"04",
		]);
	});

	test("parallel group sets parallelGroup field on tasks", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01, 02, 03 can be done in parallel`;
		const project = parseMD(md);
		expect(findTask(project, "01").parallelGroup).toBe(0);
		expect(findTask(project, "02").parallelGroup).toBe(0);
		expect(findTask(project, "03").parallelGroup).toBe(0);
	});

	test("multiple parallel groups with labels", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
- [ ] 04 — d
- [ ] 05 — e
- [ ] 06 — f
## Dependencies
01, 02 can be done in parallel (frontend)
03, 04, 05 can be done in parallel (backend)
06 depends on 01, 03`;
		const project = parseMD(md);
		expect(project.parallelGroups!.length).toBe(2);
		expect(project.parallelGroups![0].label).toBe("frontend");
		expect(project.parallelGroups![1].label).toBe("backend");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MIXED FORMATS in one file
// ─────────────────────────────────────────────────────────────────────────────

describe("Mixed dependency formats", () => {
	test("arrows + depends-on + must-before in one file", () => {
		const md = `# iOS OAuth Sign-In

Objective: Add Google and Apple OAuth sign-in options

Status legend: [ ] todo, [~] in-progress, [x] done

## Tasks
- [~] 01 — oauth-flow-research
- [~] 02 — clerkapi-oauth-methods
- [ ] 03 — authservice-oauth-methods
- [ ] 04 — oauth-button-component
- [ ] 05 — update-signin-view
- [ ] 06 — update-signup-view
- [ ] 07 — session-handling
- [ ] 08 — integration-tests

## Dependencies
- 02 depends on 01
- 03 depends on 02
- 01 -> 04
- 05 must be done before 06
- 07 depends on 03
- 08 depends on 05, 06, 07`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
		expect(findTask(project, "03").dependencies).toEqual(["02"]);
		expect(findTask(project, "04").dependencies).toEqual(["01"]);
		expect(findTask(project, "06").dependencies).toEqual(["05"]);
		expect(findTask(project, "07").dependencies).toEqual(["03"]);
		expect(findTask(project, "08").dependencies).toEqual(["05", "06", "07"]);
	});

	test("parallel groups mixed with dependencies", () => {
		const md = `# Full Project

## Tasks
- [ ] 01 — env-setup
- [ ] 02 — db-schema
- [ ] 03 — api-core
- [ ] 04 — frontend-shell
- [ ] 05 — auth-module
- [ ] 06 — user-dashboard
- [ ] 07 — admin-panel
- [ ] 08 — integration-tests
- [ ] 09 — deploy

## Dependencies
01 -> 02, 03
02 -> 05
03 -> 05
04 -> 06, 07
05 -> 06, 07
06, 07 can be done in parallel (user-facing work)
08 must be done before 09
05 depends on 02, 03
06 depends on 04, 05`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
		expect(findTask(project, "03").dependencies).toEqual(["01"]);
		expect(findTask(project, "05").dependencies).toEqual(["02", "03"]);
		expect(findTask(project, "06").dependencies).toEqual(["04", "05"]);
		expect(findTask(project, "07").dependencies.sort()).toEqual(["04", "05"]);
		expect(findTask(project, "09").dependencies).toEqual(["08"]);
		expect(project.parallelGroups).toBeDefined();
		expect(project.parallelGroups!.length).toBe(1);
		expect(project.parallelGroups![0].taskIds.sort()).toEqual(["06", "07"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// DAG CONSTRUCTION (Kahn's Algorithm)
// ─────────────────────────────────────────────────────────────────────────────

describe("DAG construction (Kahn's algorithm)", () => {
	test("simple linear chain produces sequential batches", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02 -> 03`;
		const p = plan(parseMD(md));
		expect(batchIds(p)).toEqual([["01"], ["02"], ["03"]]);
	});

	test("diamond dependency produces 3 batches", () => {
		const md = `# Test
## Tasks
- [ ] 01 — setup
- [ ] 02 — frontend
- [ ] 03 — backend
- [ ] 04 — integration
## Dependencies
01 -> 02, 03
02 -> 04
03 -> 04`;
		const p = plan(parseMD(md));
		// 01 first, then 02+03 in parallel, then 04
		expect(batchIds(p)).toEqual([["01"], ["02", "03"], ["04"]]);
	});

	test("fan-out: one task gates many", () => {
		const md = `# Test
## Tasks
- [ ] 01 — foundation
- [ ] 02 — feature-a
- [ ] 03 — feature-b
- [ ] 04 — feature-c
## Dependencies
01 -> 02, 03, 04`;
		const p = plan(parseMD(md));
		expect(batchIds(p)).toEqual([["01"], ["02", "03", "04"]]);
	});

	test("fan-in: many converge on one", () => {
		const md = `# Test
## Tasks
- [ ] 01 — data
- [ ] 02 — ui
- [ ] 03 — api
- [ ] 04 — integration
## Dependencies
01, 02, 03 -> 04`;
		const p = plan(parseMD(md));
		expect(batchIds(p)).toEqual([["01", "02", "03"], ["04"]]);
	});

	test("complex DAG with multiple dependency chains", () => {
		//         01
		//        /  \
		//       02   03
		//       |    |
		//       04   05
		//        \  /
		//         06
		//         |
		//         07
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
- [ ] 04 — d
- [ ] 05 — e
- [ ] 06 — f
- [ ] 07 — g
## Dependencies
01 -> 02, 03
02 -> 04
03 -> 05
04, 05 -> 06
06 -> 07`;
		const p = plan(parseMD(md));
		expect(batchIds(p)).toEqual([
			["01"],
			["02", "03"],
			["04", "05"],
			["06"],
			["07"],
		]);
	});

	test("no dependencies = all in one batch", () => {
		// Content without ## Dependencies — uses simple checkbox parsing
		// Simple checkbox assigns auto-incrementing IDs starting from "00"
		const project = parseMD(`# Test\n- [ ] 01 — a\n- [ ] 02 — b\n- [ ] 03 — c`);
		const p = plan(project);
		// Simple checkbox: no dependencies, so all pending = all ready = one batch
		expect(batchIds(p)).toEqual([["00", "01", "02"]]);
	});

	test("completed tasks are excluded from batches", () => {
		const md = `# Test
## Tasks
- [x] 01 — setup (done)
- [ ] 02 — build
- [ ] 03 — test
## Dependencies
01 -> 02 -> 03`;
		const project = parseMD(md);
		// 01 is [x] in file, buildCompletedSet would include it
		const p = buildExecutionPlan(
			project,
			new Set(["01"]), // completed
		);
		expect(batchIds(p)).toEqual([["02"], ["03"]]);
		expect(p.totalTasks).toBe(2);
	});

	test("all completed = empty plan", () => {
		const md = `# Test
## Tasks
- [x] 01 — a
- [x] 02 — b
## Dependencies
01 -> 02`;
		const project = parseMD(md);
		const p = buildExecutionPlan(project, new Set(["01", "02"]));
		expect(batchIds(p)).toEqual([]);
		expect(p.totalTasks).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SEQUENTIAL PLAN
// ─────────────────────────────────────────────────────────────────────────────

describe("Sequential plan", () => {
	test("each batch has exactly one task", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02 -> 03`;
		const project = parseMD(md);
		const p = buildSequentialPlan(project, new Set());
		expect(p.batches.length).toBe(3);
		for (const b of p.batches) {
			expect(b.tasks.length).toBe(1);
		}
	});

	test("sequential plan respects dependency order", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02 -> 03`;
		const project = parseMD(md);
		const p = buildSequentialPlan(project, new Set());
		expect(p.batches[0].tasks[0].id).toBe("01");
		expect(p.batches[1].tasks[0].id).toBe("02");
		expect(p.batches[2].tasks[0].id).toBe("03");
	});

	test("sequential excludes completed tasks", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02 -> 03`;
		const project = parseMD(md);
		const p = buildSequentialPlan(project, new Set(["01"]));
		expect(p.batches.length).toBe(2);
		expect(p.batches[0].tasks[0].id).toBe("02");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CYCLE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

describe("Cycle detection", () => {
	test("no cycle = empty array", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
## Dependencies
01 -> 02`;
		const project = parseMD(md);
		expect(detectCycles(project)).toEqual([]);
	});

	test("direct cycle: A -> B -> A", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
## Dependencies
01 -> 02
02 -> 01`;
		const project = parseMD(md);
		const cycles = detectCycles(project);
		expect(cycles.length).toBeGreaterThan(0);
	});

	test("indirect cycle: A -> B -> C -> A", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02
02 -> 03
03 -> 01`;
		const project = parseMD(md);
		const cycles = detectCycles(project);
		expect(cycles.length).toBeGreaterThan(0);
	});

	test("self-loop: A -> A", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
## Dependencies
01 -> 01`;
		const project = parseMD(md);
		const cycles = detectCycles(project);
		expect(cycles.length).toBeGreaterThan(0);
	});

	test("buildExecutionPlan throws on cycle", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
## Dependencies
01 -> 02
02 -> 01`;
		const project = parseMD(md);
		expect(() => buildExecutionPlan(project, new Set())).toThrow(/cycle/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKED TASKS
// ─────────────────────────────────────────────────────────────────────────────

describe("Blocked tasks", () => {
	test("direct dependent blocked", () => {
		const tasks: Task[] = [
			{ id: "01", title: "a", status: "pending", dependencies: [] },
			{ id: "02", title: "b", status: "pending", dependencies: ["01"] },
			{ id: "03", title: "c", status: "pending", dependencies: ["02"] },
		];
		const blocked = getBlockedTasks(tasks, new Set(["01"]));
		expect(blocked.has("02")).toBe(true);
	});

	test("transitive blocking", () => {
		const tasks: Task[] = [
			{ id: "01", title: "a", status: "pending", dependencies: [] },
			{ id: "02", title: "b", status: "pending", dependencies: ["01"] },
			{ id: "03", title: "c", status: "pending", dependencies: ["02"] },
			{ id: "04", title: "d", status: "pending", dependencies: [] },
		];
		const blocked = getBlockedTasks(tasks, new Set(["01"]));
		expect(blocked.has("02")).toBe(true);
		expect(blocked.has("03")).toBe(true);
		expect(blocked.has("04")).toBe(false); // independent
	});

	test("no failed = nothing blocked", () => {
		const tasks: Task[] = [
			{ id: "01", title: "a", status: "pending", dependencies: [] },
			{ id: "02", title: "b", status: "pending", dependencies: ["01"] },
		];
		const blocked = getBlockedTasks(tasks, new Set());
		expect(blocked.size).toBe(0);
	});

	test("buildExecutionPlan excludes blocked tasks from batches", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02 -> 03`;
		const project = parseMD(md);
		const p = buildExecutionPlan(
			project,
			new Set(),
			undefined,
			new Set(["01"]),
		);
		// 02 and 03 are blocked because 01 failed. 01 is excluded (failed).
		// 02 and 03 remain pending but don't appear in batches.
		expect(batchIds(p)).toEqual([]);
		expect(p.totalTasks).toBe(2); // 02, 03 are pending (blocked)
	});

	test("blocked with diamond: failing root blocks everything downstream", () => {
		const md = `# Test
## Tasks
- [ ] 01 — setup
- [ ] 02 — frontend
- [ ] 03 — backend
- [ ] 04 — integration
## Dependencies
01 -> 02, 03
02 -> 04
03 -> 04`;
		const project = parseMD(md);
		const p = buildExecutionPlan(
			project,
			new Set(),
			undefined,
			new Set(["01"]),
		);
		// All tasks are blocked since 01 failed
		expect(batchIds(p)).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL PATH
// ─────────────────────────────────────────────────────────────────────────────

describe("Critical path", () => {
	test("linear chain critical path is the whole chain", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02 -> 03`;
		const project = parseMD(md);
		const cp = getCriticalPath(project);
		expect(cp.map((t) => t.id)).toEqual(["01", "02", "03"]);
	});

	test("diamond: critical path is the longer chain", () => {
		const md = `# Test
## Tasks
- [ ] 01 — setup
- [ ] 02 — short
- [ ] 03 — long
- [ ] 04 — end
## Dependencies
01 -> 02 -> 04
01 -> 03 -> 04`;
		// Both chains are length 3, so either is valid
		const project = parseMD(md);
		const cp = getCriticalPath(project);
		expect(cp.length).toBe(3);
		expect(cp[0].id).toBe("01");
	});

	test("fan-out: critical path covers the longest depth", () => {
		const md = `# Test
## Tasks
- [ ] 01 — root
- [ ] 02 — a
- [ ] 03 — b
- [ ] 04 — c
- [ ] 05 — d
## Dependencies
01 -> 02, 03, 04
04 -> 05`;
		const project = parseMD(md);
		const cp = getCriticalPath(project);
		// Critical path: 01 -> 04 -> 05
		expect(cp.map((t) => t.id)).toEqual(["01", "04", "05"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET READY TASKS
// ─────────────────────────────────────────────────────────────────────────────

describe("getReadyTasks", () => {
	test("root tasks are ready when nothing completed", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02 -> 03`;
		const project = parseMD(md);
		const ready = getReadyTasks(project, new Set());
		expect(ready.map((t) => t.id)).toEqual(["01"]);
	});

	test("task becomes ready when all deps completed", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01 -> 02 -> 03`;
		const project = parseMD(md);
		const ready = getReadyTasks(project, new Set(["01"]));
		expect(ready.map((t) => t.id)).toEqual(["02"]);
	});

	test("all independent tasks are ready", () => {
		const project = parseMD(`# Test\n- [ ] 01 — a\n- [ ] 02 — b\n- [ ] 03 — c`);
		const ready = getReadyTasks(project, new Set());
		expect(ready.length).toBe(3);
	});

	test("completed task is not ready", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
## Dependencies
01 -> 02`;
		const project = parseMD(md);
		const ready = getReadyTasks(project, new Set(["01"]));
		expect(ready.map((t) => t.id)).toEqual(["02"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE CASES & NEGATIVE TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe("Edge cases", () => {
	test("empty dependencies section produces no deps", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
## Dependencies`;
		const project = parseMD(md);
		expect(findTask(project, "01").dependencies).toEqual([]);
		expect(findTask(project, "02").dependencies).toEqual([]);
	});

	test("no dependencies section triggers simple checkbox parser", () => {
		const md = `# Simple List
- [ ] 01 — task-a
- [ ] 02 — task-b
- [ ] 03 — task-c`;
		const project = parseMD(md);
		expect(project.tasks.length).toBe(3);
		expect(project.dependencies).toEqual({});
	});

	test("simple checkbox parser assigns sequential zero-padded IDs", () => {
		const md = `- [ ] Do something
- [ ] Do something else`;
		const project = parseMD(md);
		expect(project.tasks[0].id).toBe("00");
		expect(project.tasks[1].id).toBe("01");
	});

	test("line with non-dep content in ## Dependencies is ignored", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
## Dependencies
Some explanatory text that isn't a valid dependency format.
- 01 -> 02`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
	});

	test("comment after 'can be done in parallel' doesn't break parsing", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
- [ ] 02 — b
- [ ] 03 — c
## Dependencies
01, 02, 03 can be done in parallel
01 -> 02
# some comment`;
		const project = parseMD(md);
		expect(project.parallelGroups).toBeDefined();
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
	});

	test("exit criteria are extracted", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a
## Dependencies
## Exit Criteria
- All tests pass
- Code reviewed
- Deployed to staging`;
		const project = parseMD(md);
		expect(project.exitCriteria).toEqual([
			"All tests pass",
			"Code reviewed",
			"Deployed to staging",
		]);
	});

	test("objective extracted from top heading", () => {
		const md = `# iOS OAuth Sign-In

Objective: Add Google and Apple OAuth sign-in options

## Tasks
- [ ] 01 — research
## Dependencies`;
		const project = parseMD(md);
		expect(project.objective).toBe("iOS OAuth Sign-In");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTIONS SEPARATION — content between ## sections is ignored
// ─────────────────────────────────────────────────────────────────────────────

describe("Section separation", () => {
	test("content between ## sections doesn't leak into tasks/deps", () => {
		const md = `# Test
## Tasks
- [ ] 01 — a

Some stray text here that isn't a task

- [ ] 02 — b

## Dependencies
01 -> 02

Extra text in deps should be ignored`;
		const project = parseMD(md);
		expect(project.tasks.length).toBe(2);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL-WORLD SCENARIO: Full PRD with complex deps
// ─────────────────────────────────────────────────────────────────────────────

describe("Real-world PRD scenario", () => {
	test("design token integration with must-before + depends-on + arrows", () => {
		const md = `# iOS Design Token Integration

Objective: Replace hardcoded color/spacing values with centralized design tokens

## Tasks
- [x] 01 — migrate-domain-colors
- [x] 02 — replace-corner-radius
- [x] 03 — replace-system-color-leakage
- [~] 04 — replace-raw-spacing-values
- [ ] 05 — replace-border-token-props
- [ ] 06 — replace-font-token-props
- [ ] 07 — fix-component-color-variants
- [ ] 08 — fix-dark-mode-utility-class

## Dependencies
01 -> 02, 03
02 -> 04
03 -> 05
04, 05 -> 06, 07, 08
06 depends on 07`;
		const project = parseMD(md);
		expect(findTask(project, "02").dependencies).toEqual(["01"]);
		expect(findTask(project, "03").dependencies).toEqual(["01"]);
		expect(findTask(project, "04").dependencies).toEqual(["02"]);
		expect(findTask(project, "05").dependencies).toEqual(["03"]);
		expect(findTask(project, "06").dependencies).toEqual(["04", "05", "07"]);
		expect(findTask(project, "07").dependencies).toEqual(["04", "05"]);
		expect(findTask(project, "08").dependencies).toEqual(["04", "05"]);

		// Plan with 01,02,03 completed
		const p = buildExecutionPlan(project, new Set(["01", "02", "03"]));
		// Batch 1: 04, 05 (both deps satisfied)
		// Batch 2: 07 (depends on 04,05)
		// Batch 3: 06 (depends on 04,05,07), 08 (depends on 04,05)
		expect(batchIds(p)).toEqual([["04", "05"], ["07", "08"], ["06"]]);
	});
});
