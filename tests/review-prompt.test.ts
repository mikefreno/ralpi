/**
 * Tests for the review prompt builders (src/prompts.ts).
 * Covers: per-file summary table, excluded-files section, oversized-diff
 * read-instruction (never byte-truncates), custom review focus, and the
 * configurable noise-filter overrides surfacing in the prompt.
 */

import { describe, test, expect } from "bun:test";
import { buildReviewPrompt, buildReviewPromptUncommitted } from "../src/prompts";
import { compileIgnorePatterns } from "../src/diff";
import type { Task, Project } from "../src/types";

const task: Task = {
	id: "01",
	title: "Implement auth",
	description: "Add a login flow",
	status: "completed",
	dependencies: [],
};

const project: Project = {
	objective: "Build the app",
	sourcePath: "README.md",
	sourceDir: "/tmp",
	tasks: [task],
	dependencies: {},
};

/** A diff mixing one code file plus lockfile/minified/binary noise. */
const MIXED_DIFF = [
	"diff --git a/src/auth.ts b/src/auth.ts",
	"index 111..222 100644",
	"--- a/src/auth.ts",
	"+++ b/src/auth.ts",
	"@@ -1,3 +1,5 @@",
	" import { hash } from \"./hash\";",
	"+export function login() {",
	"+  return hash(secret);",
	"-  return legacy();",
	"+}",
	"",
	"diff --git a/package-lock.json b/package-lock.json",
	"index 000..111 100644",
	"--- a/package-lock.json",
	"+++ b/package-lock.json",
	"@@ -0,0 +1,3 @@",
	"+{",
	'+  "name": "x"',
	"+}",
	"",
	"diff --git a/assets/logo.png b/assets/logo.png",
	"index 111..222 100644",
	"Binary files differ",
	"",
	"diff --git a/dist/app.min.js b/dist/app.min.js",
	"index 111..222 100644",
	"--- a/dist/app.min.js",
	"+++ b/dist/app.min.js",
	"@@ -1 +1 @@",
	"-var a=1;",
	"+var a=2;",
].join("\n");

function manyFileDiff(n: number): string {
	const chunks: string[] = [];
	for (let i = 0; i < n; i++) {
		chunks.push(
			`diff --git a/src/f${String(i).padStart(2, "0")}.ts b/src/f${String(i).padStart(2, "0")}.ts`,
			"--- a/src/f.ts",
			"+++ b/src/f.ts",
			`+line ${i}`,
		);
	}
	return chunks.join("\n");
}

describe("buildReviewPrompt", () => {
	test("emits a per-file +/− summary table with totals, excluding noise", () => {
		const prompt = buildReviewPrompt(
			task,
			project,
			"abc1234",
			"feat: auth",
			MIXED_DIFF,
		);

		expect(prompt).toContain("### Changed Files");
		expect(prompt).toContain("| `src/auth.ts` | +3/-1 | ts |");
		expect(prompt).toContain("| **Total** | **+3/-1** | |");
	});

	test("surfaces an excluded-files section with path, counts, and reason", () => {
		const prompt = buildReviewPrompt(
			task,
			project,
			"abc1234",
			"feat: auth",
			MIXED_DIFF,
		);

		expect(prompt).toContain("### Excluded Files (3)");
		expect(prompt).toContain("- `package-lock.json` (+3/-0) — lockfile");
		expect(prompt).toContain("- `assets/logo.png` (+0/-0) — binary/media asset");
		expect(prompt).toContain("- `dist/app.min.js` (+1/-1) — minified asset");
	});

	test("never inlines excluded (noise) chunks into the diff block", () => {
		const prompt = buildReviewPrompt(
			task,
			project,
			"abc1234",
			"feat: auth",
			MIXED_DIFF,
		);

		// The noise chunks themselves are never inlined — only the excluded-files
		// section names them (as `- path (+x/-y) — reason`, no `diff --git` header).
		expect(prompt).not.toContain("diff --git a/package-lock.json");
		expect(prompt).not.toContain("diff --git a/assets/logo.png");
		expect(prompt).not.toContain("diff --git a/dist/app.min.js");
		// The cleaned diff block is present with the code file.
		expect(prompt).toContain("```diff");
		expect(prompt).toContain("diff --git a/src/auth.ts");
	});

	test("omits the excluded section entirely when nothing is excluded", () => {
		const clean = [
			"diff --git a/src/auth.ts b/src/auth.ts",
			"--- a/src/auth.ts",
			"+++ b/src/auth.ts",
			"+export const x = 1;",
		].join("\n");
		const prompt = buildReviewPrompt(
			task,
			project,
			"abc1234",
			"feat: auth",
			clean,
		);
		expect(prompt).not.toContain("### Excluded Files");
		expect(prompt).toContain("| `src/auth.ts` | +1/-0 | ts |");
	});

	test("switches to a file-list + read instruction for >20 files, no truncation", () => {
		const prompt = buildReviewPrompt(
			task,
			project,
			"abc1234",
			"feat: many",
			manyFileDiff(21),
		);

		expect(prompt).toContain("Diff too large");
		expect(prompt).toContain("Use `read` to inspect the changed files");
		// No byte-truncated inline diff for oversized inputs.
		expect(prompt).not.toContain("```diff");
	});

	test("inlines a small diff normally (no read-instruction)", () => {
		const prompt = buildReviewPrompt(
			task,
			project,
			"abc1234",
			"feat: auth",
			MIXED_DIFF,
		);
		expect(prompt).not.toContain("Diff too large");
	});

	test("emits a Custom Review Focus section only when focus is set", () => {
		const withFocus = buildReviewPrompt(
			task,
			project,
			"abc1234",
			"feat: auth",
			MIXED_DIFF,
			{ focus: "check security only" },
		);
		expect(withFocus).toContain("## Custom Review Focus");
		expect(withFocus).toContain("check security only");

		const withoutFocus = buildReviewPrompt(
			task,
			project,
			"abc1234",
			"feat: auth",
			MIXED_DIFF,
		);
		expect(withoutFocus).not.toContain("## Custom Review Focus");
	});

	test("surfaces extra ignore patterns and ignorePaths overrides in the prompt", () => {
		const diff = [
			"diff --git a/src/keep.ts b/src/keep.ts",
			"--- a/src/keep.ts",
			"+++ b/src/keep.ts",
			"+keep",
			"diff --git a/package-lock.json b/package-lock.json",
			"--- a/package-lock.json",
			"+++ b/package-lock.json",
			"+a",
			"+b",
			"+c",
			"+d",
		].join("\n");

		// ignorePaths keeps the lockfile in scope → it shows in the table,
		// and no excluded section is emitted.
		const kept = buildReviewPrompt(task, project, "abc1234", "x", diff, {
			diffOptions: { ignorePaths: ["package-lock.json"] },
		});
		expect(kept).toContain("| `package-lock.json` | +4/-0 | json |");
		expect(kept).not.toContain("### Excluded Files");

		// Without ignorePaths, the lockfile is excluded.
		const excluded = buildReviewPrompt(task, project, "abc1234", "x", diff);
		expect(excluded).not.toContain("| `package-lock.json` |");
		expect(excluded).toContain("### Excluded Files (1)");

		// extraPatterns drops a matching file from scope.
		const dropped = buildReviewPrompt(task, project, "abc1234", "x", diff, {
			diffOptions: {
				extraPatterns: compileIgnorePatterns(["\\.ts$"]),
				ignorePaths: [],
			},
		});
		expect(dropped).not.toContain("| `src/keep.ts` |");
		expect(dropped).toContain("### Excluded Files (2)");
	});
});

describe("buildReviewPromptUncommitted", () => {
	test("emits summary table, excluded section, and cleaned diff", () => {
		const prompt = buildReviewPromptUncommitted(
			task,
			project,
			"M src/auth.ts",
			MIXED_DIFF,
		);

		expect(prompt).toContain("### Changed Files");
		expect(prompt).toContain("| `src/auth.ts` | +3/-1 | ts |");
		expect(prompt).toContain("### Excluded Files (3)");
		expect(prompt).not.toContain("diff --git a/package-lock.json");
		expect(prompt).toContain("### Current Tracked Diff (git diff)");
	});

	test("supports custom focus", () => {
		const prompt = buildReviewPromptUncommitted(
			task,
			project,
			"M src/auth.ts",
			MIXED_DIFF,
			{ focus: "review performance" },
		);
		expect(prompt).toContain("## Custom Review Focus");
		expect(prompt).toContain("review performance");
	});
});
