/// <reference types="bun-types" />
import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProgressTracker } from "../src/progress";
import { countPRDResumeStats } from "../src/utils";

/**
 * Regression test: the resume-selection prompt under-reported task totals
 * when multiple loop histories existed. The progress tracker only records
 * TOUCHED tasks (started/completed/failed) — never-started tasks are absent
 * from prd.tasks, so a naive Object.keys() count missed them entirely, and
 * file-checked completions were ignored unless markCompleted had run.
 * countPRDResumeStats derives the true total from the parsed PRD file and
 * counts checkbox completions too.
 */
let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ralpi-stats-test-"));
});

const PRD_CONTENT = `# Test PRD

## Tasks
- [ ] Task one
- [x] Task two
- [ ] Task three
- [ ] Task four
`;

function writePRD(rel: string): string {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, PRD_CONTENT, "utf-8");
	return p;
}

describe("countPRDResumeStats", () => {
	it("reports the full task total from the PRD file, not just touched tasks", () => {
		const sourcePath = writePRD("tasks/a/README.md");
		const progress = new ProgressTracker(root, sourcePath);

		// Simple-checkbox format assigns sequential ids 00-03. Only 00
		// (completed) and 02 (failed) were touched by the loop; 01 is checked
		// off in the file; 03 was never started.
		progress.markCompleted("00", 1000);
		progress.markFailed("02", "boom");

		const stats = countPRDResumeStats(progress.getState(), sourcePath);
		expect(stats.total).toBe(4); // old code reported 2
		expect(stats.completed).toBe(2); // 00 via progress + 01 via checkbox
		expect(stats.failed).toBe(1);
	});

	it("does not double-count a task that is both progress-completed and file-checked", () => {
		const sourcePath = writePRD("tasks/b/README.md");
		const progress = new ProgressTracker(root, sourcePath);

		progress.markCompleted("01", 500); // 01 already [x] in the file

		const stats = countPRDResumeStats(progress.getState(), sourcePath);
		expect(stats.completed).toBe(1);
	});

	it("falls back to touched-task counts when the PRD file is missing", () => {
		const missing = path.join(root, "tasks/gone/README.md");
		const progress = new ProgressTracker(root, missing);
		progress.markCompleted("01", 1000);
		progress.markFailed("02", "nope");

		const stats = countPRDResumeStats(progress.getState(), missing);
		expect(stats.total).toBe(2);
		expect(stats.completed).toBe(1);
		expect(stats.failed).toBe(1);
	});

	it("reports zero for a never-touched PRD with no file", () => {
		const missing = path.join(root, "tasks/none/README.md");
		const progress = new ProgressTracker(root, missing);
		const stats = countPRDResumeStats(progress.getState(), missing);
		expect(stats.total).toBe(0);
		expect(stats.completed).toBe(0);
		expect(stats.failed).toBe(0);
	});
});
