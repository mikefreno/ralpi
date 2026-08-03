/// <reference types="bun-types" />
import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProgressTracker } from "../src/progress";

/**
 * Regression test: two concurrent loops (different PRDs) each run their own
 * ProgressTracker. Each instance snapshots the whole state at construction;
 * a save() that writes that stale snapshot verbatim would revert the OTHER
 * loop's task status changes — tasks wrongly back to "pending" while their
 * worktrees carry real work, stranding it on the next resume.
 */
let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ralpi-prog-test-"));
});

function prdA(projectDir: string): ProgressTracker {
	return new ProgressTracker(
		projectDir,
		path.join(projectDir, "tasks/a/README.md"),
	);
}
function prdB(projectDir: string): ProgressTracker {
	return new ProgressTracker(
		projectDir,
		path.join(projectDir, "tasks/b/README.md"),
	);
}

/** Read the on-disk progress state; the file is written by the tracker, so
 *  a parse failure is a test bug worth surfacing. */
function readState(): Record<string, any> {
	const raw = fs.readFileSync(
		path.join(root, ".ralpi", "progress.json"),
		"utf-8",
	);
	try {
		return JSON.parse(raw) as Record<string, any>;
	} catch {
		throw new Error(`malformed progress.json:\n${raw.slice(0, 200)}`);
	}
}

describe("ProgressTracker multi-PRD save isolation", () => {
	it("does not clobber another PRD's task status on save", () => {
		const a = prdA(root);
		const b = prdB(root);
		expect(a.getKey()).not.toBe(b.getKey());

		// Loop A marks its task in_progress.
		a.markInProgress("01");
		expect(a.getTaskStatus("01")).toBe("in_progress");

		// Loop B (stale snapshot from before A's update) marks ITS task.
		b.markInProgress("02");

		// The on-disk state must show BOTH updates.
		const raw = readState();
		expect(raw.prds[a.getKey()].tasks["01"].status).toBe("in_progress");
		expect(raw.prds[b.getKey()].tasks["02"].status).toBe("in_progress");
	});

	it("preserves other PRD completions when this PRD saves", () => {
		const a = prdA(root);
		const b = prdB(root);

		a.markCompleted("01", 1000);
		b.markInProgress("02");

		// A completes another task later — A's save must not revert B.
		a.markCompleted("03", 500);

		const raw = readState();
		expect(raw.prds[a.getKey()].tasks["01"].status).toBe("completed");
		expect(raw.prds[a.getKey()].tasks["03"].status).toBe("completed");
		expect(raw.prds[b.getKey()].tasks["02"].status).toBe("in_progress");
	});
});
