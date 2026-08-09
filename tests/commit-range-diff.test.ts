/**
 * Tests for the tri-state commit-range diff (src/utils.ts getCommitRangeDiff):
 * a FAILED range computation (invalid/stale base ref, git error) must be a
 * distinct `error` signal, never collapsed into a clean `no-changes` — a
 * broken base ref must never be silently treated as a verified task.
 *
 * Uses a real throwaway git repo so the shell-out behavior is exercised.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { getCommitRangeDiff } from "../src/utils";

let repoDir: string;

function sh(cmd: string, cwd: string) {
	execSync(cmd, { cwd, stdio: "pipe" });
}

beforeAll(() => {
	repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralpi-crd-"));
	sh("git init -q", repoDir);
	sh("git config user.email test@example.com", repoDir);
	sh("git config user.name test", repoDir);
	fs.writeFileSync(path.join(repoDir, "a.ts"), "one\n", "utf-8");
	sh("git add -A", repoDir);
	sh("git commit -q -m init", repoDir);
});

afterAll(() => {
	fs.rmSync(repoDir, { recursive: true, force: true });
});

describe("getCommitRangeDiff tri-state", () => {
	test("ok: a resolvable base with committed changes yields the diff", () => {
		fs.writeFileSync(path.join(repoDir, "a.ts"), "one\ntwo\n", "utf-8");
		sh("git add -A", repoDir);
		sh("git commit -q -m change", repoDir);

		const base = execSync("git rev-parse HEAD~1", {
			cwd: repoDir,
			encoding: "utf-8",
		}).trim();

		const result = getCommitRangeDiff(repoDir, base);
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.diff).toContain("a.ts");
			expect(result.hash.length).toBeGreaterThan(0);
		}
	});

	test("error: a fake/unresolvable base ref yields the failure signal, not no-changes", () => {
		// 40 hex chars that never existed in this repo.
		const fake = "ffffffffffffffffffffffffffffffffffffffff";
		const result = getCommitRangeDiff(repoDir, fake);
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.error).toContain("cannot be resolved");
		}
	});

	test("error: a non-hex base ref is rejected before reaching the shell", () => {
		const result = getCommitRangeDiff(repoDir, "HEAD~1; rm -rf /");
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.error).toContain("invalid or stale base ref");
		}
	});

	test("no-changes: an empty range (base == HEAD) yields the no-changes signal", () => {
		const head = execSync("git rev-parse HEAD", {
			cwd: repoDir,
			encoding: "utf-8",
		}).trim();
		const result = getCommitRangeDiff(repoDir, head);
		expect(result.kind).toBe("no-changes");
	});
});
