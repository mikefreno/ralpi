/// <reference types="bun-types" />
import { describe, it, expect } from "bun:test";
import { parseTaskFile } from "../src/parser";
import { tempDir, writeTaskFile } from "./helpers";

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Parse a task file from an inline template literal. */
function parse(content: string) {
	const { dir, cleanup } = tempDir();
	try {
		const filePath = writeTaskFile(dir, "README.md", content);
		return { project: parseTaskFile(filePath), cleanup };
	} catch (e) {
		cleanup();
		throw e;
	}
}

/** Assert that task with `id` has the exact set of dependency IDs. */
function expectDeps(content: string, id: string, expectedDeps: string[]) {
	const { project, cleanup } = parse(content);
	try {
		const task = project.tasks.find((t) => t.id === id);
		if (!task) throw new Error(`Task ${id} not found`);
		expect(task.dependencies.sort()).toEqual([...expectedDeps].sort());
	} finally {
		cleanup();
	}
}

// ─── Helpers for constructing header + task table ────────────────────────────

const FIO_HEADER = `# Test Project

## Tasks`;

const FIO_FOOTER = `## Dependencies`;

// ─── Arrow Notation Tests ────────────────────────────────────────────────────

describe("Arrow notation (`->`)", () => {
	it("parses basic single dependency", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Task one
- [ ] 02 — Task two

${FIO_FOOTER}
- 01 -> 02
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks).toHaveLength(2);
			const t1 = project.tasks.find((t) => t.id === "01")!;
			const t2 = project.tasks.find((t) => t.id === "02")!;
			expect(t1.dependencies).toEqual([]);
			expect(t2.dependencies).toEqual(["01"]);
		} finally {
			cleanup();
		}
	});

	it("parses multi-target arrows (one source, many targets)", () => {
		expectDeps(
			`${FIO_HEADER}
- [ ] 01 — Task one
- [ ] 02 — Task two
- [ ] 03 — Task three

${FIO_FOOTER}
- 01 -> 02, 03
`,
			"02",
			["01"],
		);
	});

	it("parses chained arrows (A -> B -> C)", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Task one
- [ ] 02 — Task two
- [ ] 03 — Task three

${FIO_FOOTER}
- 01 -> 02 -> 03
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"02",
			]);
		} finally {
			cleanup();
		}
	});

	it("parses chained arrows with multi-target forks", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Task one
- [ ] 02 — Task two
- [ ] 03 — Task three
- [ ] 04 — Task four

${FIO_FOOTER}
- 01 -> 02, 03 -> 04
`;
		const { project, cleanup } = parse(content);
		try {
			// 01 -> 02,03: 02 and 03 depend on 01
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"01",
			]);
			// 02, 03 -> 04: 04 depends on BOTH 02 and 03 (chained multi-target fork)
			expect(
				project.tasks.find((t) => t.id === "04")!.dependencies.sort(),
			).toEqual(["02", "03"]);
		} finally {
			cleanup();
		}
	});

	it("parses unicode arrow (→)", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Task one
- [ ] 02 — Task two

${FIO_FOOTER}
- 01 → 02
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
		} finally {
			cleanup();
		}
	});

	it("parses arrows with parenthetical descriptions", () => {
		expectDeps(
			`${FIO_HEADER}
- [ ] 01 — Domain colors
- [ ] 02 — Corner radius
- [ ] 03 — Color leakage
- [ ] 04 — Raw spacing

${FIO_FOOTER}
- 01 -> 02 (SemanticColors tokens must exist before views consume them)
- 01 -> 03 (Color tokens needed for system color replacement)
- 02 -> 04 (independent — sequential for clean git history)
- 03 -> 04 (independent — sequential for clean git history)
`,
			"02",
			["01"],
		);
	});

	it("parses multi-source, multi-target arrows", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Research
- [ ] 02 — API design
- [ ] 03 — Implementation
- [ ] 04 — Review
- [ ] 05 — Merge

${FIO_FOOTER}
- 01, 02, 03 -> 04 -> 05
`;
		const { project, cleanup } = parse(content);
		try {
			// 01,02,03 -> 04: 04 depends on 01,02,03
			expect(
				project.tasks.find((t) => t.id === "04")!.dependencies.sort(),
			).toEqual(["01", "02", "03"]);
			// 04 -> 05: 05 depends on 04
			expect(project.tasks.find((t) => t.id === "05")!.dependencies).toEqual([
				"04",
			]);
		} finally {
			cleanup();
		}
	});
});

// ─── "depends on" Format Tests ───────────────────────────────────────────────

describe('"depends on" format', () => {
	it("parses basic 'X depends on Y'", () => {
		expectDeps(
			`${FIO_HEADER}
- [ ] 01 — OAuth research
- [ ] 02 — Clerk API

${FIO_FOOTER}
- 02 depends on 01
`,
			"02",
			["01"],
		);
	});

	it("parses 'X depends on Y, Z' (multi-dependency)", () => {
		expectDeps(
			`${FIO_HEADER}
- [ ] 01 — Sign-in design
- [ ] 02 — Sign-up design
- [ ] 03 — OAuth buttons
- [ ] 04 — Reuse buttons

${FIO_FOOTER}
- 04 depends on 01, 02, 03
`,
			"04",
			["01", "02", "03"],
		);
	});

	it("parses 'X also depends on Y'", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Foundation
- [ ] 02 — Feature A
- [ ] 03 — Feature B
- [ ] 04 — Integration

${FIO_FOOTER}
- 04 depends on 02, 03
- 04 also depends on 01
`;
		const { project, cleanup } = parse(content);
		try {
			expect(
				project.tasks.find((t) => t.id === "04")!.dependencies.sort(),
			).toEqual(["01", "02", "03"]);
		} finally {
			cleanup();
		}
	});

	it("parses many depends-on lines forming a full DAG", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — OAuth research
- [ ] 02 — Clerk API methods
- [ ] 03 — AuthService methods
- [ ] 04 — OAuth button
- [ ] 05 — Update sign-in
- [ ] 06 — Update sign-up
- [ ] 07 — Callback handler
- [ ] 08 — Integration tests

${FIO_FOOTER}
- 02 depends on 01
- 03 depends on 02
- 04 depends on 01
- 05 depends on 03, 04
- 06 depends on 03, 04
- 07 depends on 03
- 08 depends on 05, 06, 07
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "01")!.dependencies).toEqual(
				[],
			);
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"02",
			]);
			expect(project.tasks.find((t) => t.id === "04")!.dependencies).toEqual([
				"01",
			]);
			expect(
				project.tasks.find((t) => t.id === "05")!.dependencies.sort(),
			).toEqual(["03", "04"]);
			expect(
				project.tasks.find((t) => t.id === "06")!.dependencies.sort(),
			).toEqual(["03", "04"]);
			expect(project.tasks.find((t) => t.id === "07")!.dependencies).toEqual([
				"03",
			]);
			expect(
				project.tasks.find((t) => t.id === "08")!.dependencies.sort(),
			).toEqual(["05", "06", "07"]);
		} finally {
			cleanup();
		}
	});
});

// ─── "depend on" (Plural) Format Tests ───────────────────────────────────────

describe('"depend on" (plural) format', () => {
	it("parses 'X, Y depend on Z'", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Foundation
- [ ] 02 — Feature A
- [ ] 03 — Feature B

${FIO_FOOTER}
- 02, 03 depend on 01
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"01",
			]);
		} finally {
			cleanup();
		}
	});

	it("parses 'X, Y depend on Z, W' (multi-source, multi-dependency)", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Foundation
- [ ] 02 — API
- [ ] 03 — Feature A
- [ ] 04 — Feature B
- [ ] 05 — Integration

${FIO_FOOTER}
- 03, 04, 05 depend on 01, 02
`;
		const { project, cleanup } = parse(content);
		try {
			expect(
				project.tasks.find((t) => t.id === "03")!.dependencies.sort(),
			).toEqual(["01", "02"]);
			expect(
				project.tasks.find((t) => t.id === "04")!.dependencies.sort(),
			).toEqual(["01", "02"]);
			expect(
				project.tasks.find((t) => t.id === "05")!.dependencies.sort(),
			).toEqual(["01", "02"]);
		} finally {
			cleanup();
		}
	});

	it("handles mixed singular/plural across different lines", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Research
- [ ] 02 — API design
- [ ] 03 — Implementation
- [ ] 04 — Tests

${FIO_FOOTER}
- 02 depends on 01
- 03, 04 depend on 02
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"02",
			]);
			expect(project.tasks.find((t) => t.id === "04")!.dependencies).toEqual([
				"02",
			]);
		} finally {
			cleanup();
		}
	});
});

// ─── "must be done before" Format Tests ─────────────────────────────────────

describe('"must be done before" format', () => {
	it("parses 'X must be done before Y'", () => {
		expectDeps(
			`${FIO_HEADER}
- [ ] 01 — Setup
- [ ] 02 — Build

${FIO_FOOTER}
- 01 must be done before 02
`,
			"02",
			["01"],
		);
	});

	it("parses 'X must be done before Y, Z' (multi-target)", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Foundation
- [ ] 02 — Feature A
- [ ] 03 — Feature B

${FIO_FOOTER}
- 01 must be done before 02, 03
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"01",
			]);
		} finally {
			cleanup();
		}
	});

	it("parses 'X, Y must be done before Z' (multi-source)", () => {
		expectDeps(
			`${FIO_HEADER}
- [ ] 01 — Auth
- [ ] 02 — Billing
- [ ] 03 — Dashboard

${FIO_FOOTER}
- 01, 02 must be done before 03
`,
			"03",
			["01", "02"],
		);
	});

	it("parses 'must be done before' with parenthetical labels", () => {
		expectDeps(
			`${FIO_HEADER}
- [ ] 21 — Backend integration
- [ ] 22 — API routes
- [ ] 23 — Database schema
- [ ] 24 — Frontend components

${FIO_FOOTER}
- 21 must be done before 22, 23, 24 (backend integration foundation)
`,
			"22",
			["21"],
		);
	});
});

// ─── Parallel Groups Format Tests ────────────────────────────────────────────

describe("Parallel groups format", () => {
	it("parses 'X, Y can be done in parallel'", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Research
- [ ] 02 — API
- [ ] 03 — UI
- [ ] 04 — Tests

${FIO_FOOTER}
- 01, 02, 03, 04 can be done in parallel
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.parallelGroups).toBeDefined();
			expect(project.parallelGroups!).toHaveLength(1);
			expect(project.parallelGroups![0].taskIds.sort()).toEqual([
				"01",
				"02",
				"03",
				"04",
			]);
		} finally {
			cleanup();
		}
	});

	it("parses parallel groups with labels", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Play Store listing
- [ ] 02 — Screenshots
- [ ] 03 — Privacy policy
- [ ] 04 — Rating prompts

${FIO_FOOTER}
- 01, 02, 03, 04 can be done in parallel (Play Store prep)
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.parallelGroups).toBeDefined();
			expect(project.parallelGroups![0].label).toBe("Play Store prep");
		} finally {
			cleanup();
		}
	});

	it("assigns parallelGroup index to tasks", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Research
- [ ] 02 — API
- [ ] 03 — UI

${FIO_FOOTER}
- 01, 02, 03 can be done in parallel
`;
		const { project, cleanup } = parse(content);
		try {
			for (const t of project.tasks) {
				expect(t.parallelGroup).toBe(0);
			}
		} finally {
			cleanup();
		}
	});
});

// ─── YAML Format Tests ───────────────────────────────────────────────────────

describe("YAML task file format", () => {
	function parseYaml(content: string) {
		const { dir, cleanup } = tempDir();
		const filePath = writeTaskFile(dir, "tasks.yaml", content);
		return { project: parseTaskFile(filePath), cleanup };
	}

	it("parses basic YAML tasks", () => {
		const content = `tasks:
  - id: "01"
    title: Research OAuth flows
    status: pending
  - id: "02"
    title: Implement Clerk API methods
    status: pending
    depends_on: ["01"]
`;
		const { project, cleanup } = parseYaml(content);
		try {
			expect(project.tasks).toHaveLength(2);
			const t2 = project.tasks.find((t) => t.id === "02")!;
			expect(t2.dependencies).toEqual(["01"]);
		} finally {
			cleanup();
		}
	});

	it("parses YAML with dependencies (dependencies key)", () => {
		const content = `tasks:
  - id: "01"
    title: Foundation
  - id: "02"
    title: Feature A
    dependencies: ["01"]
  - id: "03"
    title: Feature B
    dependencies: ["01"]
  - id: "04"
    title: Integration
    dependencies: ["02", "03"]
`;
		const { project, cleanup } = parseYaml(content);
		try {
			expect(
				project.tasks.find((t) => t.id === "04")!.dependencies.sort(),
			).toEqual(["02", "03"]);
		} finally {
			cleanup();
		}
	});

	it("parses YAML with exit criteria and objective", () => {
		const content = `objective: Complete OAuth integration
exit_criteria:
  - Users can sign in with Google
  - Users can sign in with Apple
tasks:
  - id: "01"
    title: Research
`;
		const { project, cleanup } = parseYaml(content);
		try {
			expect(project.objective).toBe("Complete OAuth integration");
			expect(project.exitCriteria).toEqual([
				"Users can sign in with Google",
				"Users can sign in with Apple",
			]);
		} finally {
			cleanup();
		}
	});
});

// ─── Mixed Format Tests ──────────────────────────────────────────────────────

describe("Mixed format files", () => {
	it("handles arrow + depends-on arrows mixed in same file", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Research
- [ ] 02 — Design
- [ ] 03 — Implement
- [ ] 04 — Test
- [ ] 05 — Deploy

${FIO_FOOTER}
- 02 depends on 01
- 03 -> 04
- 04 -> 05
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual(
				[],
			);
			expect(project.tasks.find((t) => t.id === "04")!.dependencies).toEqual([
				"03",
			]);
			expect(project.tasks.find((t) => t.id === "05")!.dependencies).toEqual([
				"04",
			]);
		} finally {
			cleanup();
		}
	});

	it("handles must-be-done-before + depends-on mixed", () => {
		const content = `${FIO_HEADER}
- [ ] 10 — Scaffold
- [ ] 11 — Backend
- [ ] 12 — Frontend
- [ ] 13 — Auth
- [ ] 14 — Deploy

${FIO_FOOTER}
- 10 must be done before 11, 12
- 13 depends on 11, 12
- 14 depends on 13
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "11")!.dependencies).toEqual([
				"10",
			]);
			expect(project.tasks.find((t) => t.id === "12")!.dependencies).toEqual([
				"10",
			]);
			expect(
				project.tasks.find((t) => t.id === "13")!.dependencies.sort(),
			).toEqual(["11", "12"]);
			expect(project.tasks.find((t) => t.id === "14")!.dependencies).toEqual([
				"13",
			]);
		} finally {
			cleanup();
		}
	});
});

// ─── Simple Checkbox Format (Fallback) Tests ─────────────────────────────────

describe("Simple checkbox format (fallback)", () => {
	it("parses simple checkboxes when no ## Dependencies section", () => {
		const content = `# Todo
- [ ] Buy groceries
- [x] Walk the dog
- [~] Do laundry
- [!] Fix bug
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks).toHaveLength(4);
			expect(project.tasks[0].status).toBe("pending");
			expect(project.tasks[1].status).toBe("completed");
			expect(project.tasks[2].status).toBe("in_progress");
			expect(project.tasks[3].status).toBe("failed");
			expect(project.dependencies).toEqual({});
		} finally {
			cleanup();
		}
	});
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe("Edge cases", () => {
	it("parses a file with no dependencies section", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Solo task
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks).toHaveLength(1);
			expect(project.tasks[0].dependencies).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("parses a file with mixed task status characters", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Pending
- [~] 02 — In progress
- [x] 03 — Completed
- [!] 04 — Failed
- [-] 05 — Skipped

${FIO_FOOTER}
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks.find((t) => t.id === "01")!.status).toBe("pending");
			expect(project.tasks.find((t) => t.id === "02")!.status).toBe(
				"in_progress",
			);
			expect(project.tasks.find((t) => t.id === "03")!.status).toBe(
				"completed",
			);
			expect(project.tasks.find((t) => t.id === "04")!.status).toBe("failed");
			expect(project.tasks.find((t) => t.id === "05")!.status).toBe("skipped");
		} finally {
			cleanup();
		}
	});

	it("preserves exit criteria content", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Task

${FIO_FOOTER}

## Exit Criteria
- Users can sign in with Google
- All tests pass
- No regressions
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.exitCriteria).toBeDefined();
			expect(project.exitCriteria).toHaveLength(3);
			expect(project.exitCriteria![0]).toBe("Users can sign in with Google");
		} finally {
			cleanup();
		}
	});

	it("extracts the objective from the H1 heading", () => {
		const content = `# iOS OAuth Sign-In

Objective: Add Google and Apple OAuth

## Tasks
- [ ] 01 — Research

## Dependencies
`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.objective).toBe("iOS OAuth Sign-In");
		} finally {
			cleanup();
		}
	});

	it("does not confuse 'depends on' inside a parenthetical comment", () => {
		expectDeps(
			`${FIO_HEADER}
- [ ] 01 — Setup
- [ ] 02 — Feature

${FIO_FOOTER}
- 01 -> 02 (this depends on the setup being complete)
`,
			"02",
			["01"],
		);
	});
});

// ─── Complex / Large DAG Tests ───────────────────────────────────────────────

describe("Complex dependency scenarios", () => {
	it("parses a 20-task diamond with multiple layers", () => {
		// Diamond: 01 feeds two middle layers which converge
		const lines: string[] = [`${FIO_HEADER}`];
		for (let i = 1; i <= 20; i++) {
			lines.push(`- [ ] ${String(i).padStart(2, "0")} — Task ${i}`);
		}
		lines.push("", `${FIO_FOOTER}`);

		// 01 -> 02..10 (left chain) and 01 -> 11..19 (right chain)
		// 10 -> 20, 19 -> 20
		const leftIds = Array.from({ length: 9 }, (_, i) =>
			String(i + 2).padStart(2, "0"),
		); // 02-10
		const rightIds = Array.from({ length: 9 }, (_, i) =>
			String(i + 11).padStart(2, "0"),
		); // 11-19
		lines.push(`- 01 -> ${leftIds.join(", ")}`);
		lines.push(`- 01 -> ${rightIds.join(", ")}`);
		lines.push(`- 10, 19 -> 20`);

		const content = lines.join("\n");
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks).toHaveLength(20);
			// All left-branch tasks depend on 01
			for (const id of leftIds) {
				expect(project.tasks.find((t) => t.id === id)!.dependencies).toEqual([
					"01",
				]);
			}
			// All right-branch tasks depend on 01
			for (const id of rightIds) {
				expect(project.tasks.find((t) => t.id === id)!.dependencies).toEqual([
					"01",
				]);
			}
			// Task 20 depends on 10 and 19
			expect(
				project.tasks.find((t) => t.id === "20")!.dependencies.sort(),
			).toEqual(["10", "19"]);
		} finally {
			cleanup();
		}
	});

	it("parses a multi-level fan-out/fan-in DAG", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Foundation
- [ ] 02 — Module A
- [ ] 03 — Module B
- [ ] 04 — Module C
- [ ] 05 — Component A1
- [ ] 06 — Component A2
- [ ] 07 — Component B1
- [ ] 08 — Component B2
- [ ] 09 — Component C1
- [ ] 10 — Integration A
- [ ] 11 — Integration B
- [ ] 12 — Integration C
- [ ] 13 — System test
- [ ] 14 — Deploy

${FIO_FOOTER}
- 01 -> 02, 03, 04
- 02 -> 05, 06
- 03 -> 07, 08
- 04 -> 09
- 05, 06 -> 10
- 07, 08 -> 11
- 09 -> 12
- 10, 11, 12 -> 13
- 13 -> 14
`;
		const { project, cleanup } = parse(content);
		try {
			expect(
				project.tasks.find((t) => t.id === "10")!.dependencies.sort(),
			).toEqual(["05", "06"]);
			expect(
				project.tasks.find((t) => t.id === "11")!.dependencies.sort(),
			).toEqual(["07", "08"]);
			expect(project.tasks.find((t) => t.id === "12")!.dependencies).toEqual([
				"09",
			]);
			expect(
				project.tasks.find((t) => t.id === "13")!.dependencies.sort(),
			).toEqual(["10", "11", "12"]);
			expect(project.tasks.find((t) => t.id === "14")!.dependencies).toEqual([
				"13",
			]);
		} finally {
			cleanup();
		}
	});

	it("parses all formats mixed into one complex file", () => {
		const content = `${FIO_HEADER}
- [ ] 01 — Config setup
- [ ] 02 — Database schema
- [ ] 03 — API routes
- [ ] 04 — Auth middleware
- [ ] 05 — Frontend shell
- [ ] 06 — User model
- [ ] 07 — Login page
- [ ] 08 — Dashboard
- [ ] 09 — Tests
- [ ] 10 — Deploy

${FIO_FOOTER}
- 01 -> 02, 03, 04 (foundational layers)
- 05, 06 depend on 02, 03
- 07 depends on 04, 06
- 08 must be done before 09
- 06, 07, 08 can be done in parallel (UI sprint)
- 09 -> 10 (quality gate before deploy)
`;
		const { project, cleanup } = parse(content);
		try {
			// Arrow
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "04")!.dependencies).toEqual([
				"01",
			]);
			// depends on (plural)
			expect(
				project.tasks.find((t) => t.id === "05")!.dependencies.sort(),
			).toEqual(["02", "03"]);
			expect(
				project.tasks.find((t) => t.id === "06")!.dependencies.sort(),
			).toEqual(["02", "03"]);
			// depends on (singular)
			expect(
				project.tasks.find((t) => t.id === "07")!.dependencies.sort(),
			).toEqual(["04", "06"]);
			// must be done before
			expect(project.tasks.find((t) => t.id === "09")!.dependencies).toEqual([
				"08",
			]);
			// arrow again
			expect(project.tasks.find((t) => t.id === "10")!.dependencies).toEqual([
				"09",
			]);
			// parallel groups
			expect(project.parallelGroups).toBeDefined();
			const uiSprint = project.parallelGroups!.find(
				(g) => g.label === "UI sprint",
			);
			expect(uiSprint).toBeDefined();
			expect(uiSprint!.taskIds.sort()).toEqual(["06", "07", "08"]);
		} finally {
			cleanup();
		}
	});
});

// ─── Plain Section Headings (without ##) ──────────────────────────────────

describe("Plain section headings (no ##)", () => {
	it("parses plain 'Tasks' and 'Dependencies' headings (the OAuth PRD format)", () => {
		const content = `# iOS OAuth Sign-In\n\nObjective: Add Google and Apple OAuth sign-in options\n\nStatus legend: [ ] todo, [~] in-progress, [x] done\n\nTasks\n- [~] 01 — oauth-flow-research\n- [~] 02 — clerkapi-oauth-methods\n- [ ] 03 — authservice-oauth-methods\n- [ ] 04 — oauth-button-component\n- [ ] 05 — update-signin-view\n- [ ] 06 — update-signup-view\n- [ ] 07 — oauth-callback-handler\n- [ ] 08 — oauth-integration-tests\n\nDependencies\n- 02 depends on 01\n- 03 depends on 02\n- 04 depends on 01\n- 05 depends on 03, 04\n- 06 depends on 03, 04\n- 07 depends on 03\n- 08 depends on 05, 06, 07\n\nExit criteria\n- Users can sign in with Google account\n- Users can sign in with Apple account\n`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks).toHaveLength(8);
			expect(project.tasks.find((t) => t.id === "01")!.dependencies).toEqual(
				[],
			);
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"02",
			]);
			expect(project.tasks.find((t) => t.id === "04")!.dependencies).toEqual([
				"01",
			]);
			expect(
				project.tasks.find((t) => t.id === "05")!.dependencies.sort(),
			).toEqual(["03", "04"]);
			expect(
				project.tasks.find((t) => t.id === "06")!.dependencies.sort(),
			).toEqual(["03", "04"]);
			expect(project.tasks.find((t) => t.id === "07")!.dependencies).toEqual([
				"03",
			]);
			expect(
				project.tasks.find((t) => t.id === "08")!.dependencies.sort(),
			).toEqual(["05", "06", "07"]);
			expect(project.exitCriteria).toBeDefined();
			expect(project.exitCriteria).toHaveLength(2);
			expect(project.objective).toBe("iOS OAuth Sign-In");
		} finally {
			cleanup();
		}
	});

	it("parses plain headings with arrow notation deps", () => {
		const content = `# Design Token Integration\n\nTasks\n- [x] 01 — Migrate domain colors\n- [x] 02 — Replace corner radius\n- [x] 03 — Replace color leakage\n- [~] 04 — Replace raw spacing\n- [ ] 05 — Increase component adoption\n\nDependencies\n- 01 -> 02 (SemanticColors tokens must exist before views consume them)\n- 01 -> 03 (SemanticColors tokens must exist before views consume them)\n- 02 -> 04 (independent for clean git history)\n- 03 -> 04 (independent for clean git history)\n- 04 -> 05 (spacing consistency before component adoption)\n- 01 -> 05 (SemanticColors tokens before component-level adoption)\n\nExit criteria\n- Zero Color.systemGroupedBackground remain\n`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks).toHaveLength(5);
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.tasks.find((t) => t.id === "03")!.dependencies).toEqual([
				"01",
			]);
			expect(
				project.tasks.find((t) => t.id === "04")!.dependencies.sort(),
			).toEqual(["02", "03"]);
			expect(
				project.tasks.find((t) => t.id === "05")!.dependencies.sort(),
			).toEqual(["01", "04"]);
		} finally {
			cleanup();
		}
	});

	it("ignores 'Status legend' line (has colon — not a section break)", () => {
		const content = `# Test\n\nStatus legend: [ ] todo, [~] in-progress, [x] done\n\nTasks\n- [ ] 01 — First\n- [~] 02 — Second\n\nDependencies\n- 02 depends on 01\n`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks).toHaveLength(2);
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
		} finally {
			cleanup();
		}
	});

	it("ignores 'Objective:' line (has colon — not a section break)", () => {
		const content = `# Test\n\nObjective: Add Google and Apple OAuth\n\nTasks\n- [ ] 01 — Research\n- [ ] 02 — Implement\n\nDependencies\n- 02 depends on 01\n`;
		const { project, cleanup } = parse(content);
		try {
			expect(project.tasks).toHaveLength(2);
			expect(project.tasks.find((t) => t.id === "02")!.dependencies).toEqual([
				"01",
			]);
			expect(project.objective).toBe("Test");
		} finally {
			cleanup();
		}
	});
});
