/// <reference types="bun-types" />
import { describe, it, expect, beforeEach } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createWorktree,
	finalizeCommittedWorktrees,
	mergeWorktree,
	removeWorktree,
	worktreeHasPreservableWork,
} from "../src/worktree";

/**
 * Regression tests for worktree resume/finalize behavior:
 *
 *  1. finalizeCommittedWorktrees merges a committed worktree branch even
 *     when the worktree carries UNTRACKED files (previously the dirty check
 *     counted `??` entries, stranding committed code in .ralpi/worktrees/).
 *  2. finalize works for tasks that are NOT in_progress (pending) — the
 *     stranded-work case after an interrupted resume.
 *  3. createWorktree reuses an existing worktree under a symlinked project
 *     path (git porcelain emits realpaths; literal path.join must not be
 *     compared verbatim).
 *  4. worktreeHasPreservableWork keeps failed-task branches alive so a
 *     timeout doesn't destroy commits the agent already made.
 */

const sh = (cmd: string, cwd: string): string => {
	try {
		return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
	} catch (err) {
		throw new Error(
			`git cmd failed in ${cwd}: ${cmd}\n${(err as Error).message}`,
		);
	}
};

const STATE_DIR = ".ralpi";
const PRD_KEY = "prd";

function makeRepo(root: string): void {
	sh("git init -q -b master .", root);
	sh("git config user.email t@t.co", root);
	sh("git config user.name T", root);
	sh("echo '# Demo' > README.md", root);
	sh("git add -A && git commit -qm init", root);
}

/** Commit work in a worktree and record the commit message. */
function commitInWorktree(wt: { dir: string }, filename: string, msg: string) {
	sh(`echo '${filename} content' > ${filename}`, wt.dir);
	sh(`git add -A && git commit -qm '${msg}'`, wt.dir);
}

function masterHasFile(root: string, filename: string): boolean {
	try {
		sh(`git show master:${filename}`, root);
		return true;
	} catch {
		return false;
	}
}

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ralpi-wt-test-"));
	makeRepo(root);
});

describe("finalizeCommittedWorktrees", () => {
	it("merges a committed worktree branch even when untracked files exist", () => {
		const wt = createWorktree(
			root,
			STATE_DIR,
			"01",
			PRD_KEY,
			undefined,
			"task one",
		)!;
		commitInWorktree(wt, "work.txt", "task 01 work");
		// The task agent left a scratch file untracked (like build artifacts).
		sh("mkdir -p scratch && echo junk > scratch/junk.bin", wt.dir);
		expect(sh("git status --porcelain", wt.dir)).toContain("??");

		const fin = finalizeCommittedWorktrees(root, STATE_DIR, PRD_KEY, ["01"]);

		expect(fin.finalized).toEqual(["01"]);
		expect(masterHasFile(root, "work.txt")).toBe(true);
	});

	it("finalizes tasks that are pending (not in_progress) with committed work", () => {
		const wt = createWorktree(
			root,
			STATE_DIR,
			"02",
			PRD_KEY,
			undefined,
			"task two",
		)!;
		commitInWorktree(wt, "b.txt", "task 02 work");
		// Simulate a prior interrupted resume: task reset to pending, branch
		// never merged.
		const fin = finalizeCommittedWorktrees(root, STATE_DIR, PRD_KEY, ["02"]);
		expect(fin.finalized).toEqual(["02"]);
		expect(masterHasFile(root, "b.txt")).toBe(true);
	});

	it("leaves a worktree with uncommitted TRACKED edits for re-run", () => {
		const wt = createWorktree(
			root,
			STATE_DIR,
			"03",
			PRD_KEY,
			undefined,
			"task three",
		)!;
		commitInWorktree(wt, "c.txt", "task 03 work");
		// Agent was mid-edit when interrupted: a tracked file modified.
		sh("echo more >> README.md", wt.dir);

		const fin = finalizeCommittedWorktrees(root, STATE_DIR, PRD_KEY, ["03"]);
		expect(fin.finalized).toEqual([]);
		expect(fin.rerun).toEqual(["03"]);
		expect(masterHasFile(root, "c.txt")).toBe(false);
	});

	it("does not re-merge an already-merged branch", () => {
		const wt = createWorktree(
			root,
			STATE_DIR,
			"04",
			PRD_KEY,
			undefined,
			"task four",
		)!;
		commitInWorktree(wt, "d.txt", "task 04 work");
		expect(mergeWorktree(root, wt.branch).success).toBe(true);
		removeWorktree(root, wt);

		// Re-create a worktree on the same (now-merged) branch tip: nothing
		// ahead of main → re-run, no spurious merge.
		const wt2 = createWorktree(
			root,
			STATE_DIR,
			"04",
			PRD_KEY,
			undefined,
			"task four",
		)!;
		commitInWorktree(wt2, "e.txt", "task 04 more work");
		const fin = finalizeCommittedWorktrees(root, STATE_DIR, PRD_KEY, ["04"]);
		expect(fin.finalized).toEqual(["04"]);
		expect(masterHasFile(root, "e.txt")).toBe(true);
	});

	it("reports conflicts and preserves the worktree", () => {
		const wt = createWorktree(
			root,
			STATE_DIR,
			"05",
			PRD_KEY,
			undefined,
			"task five",
		)!;
		// Both sides edit f.txt: master AFTER the worktree exists, so the
		// branches genuinely diverge and the merge must conflict.
		sh(
			"echo master > f.txt && git add -A && git commit -qm 'master f.txt'",
			root,
		);
		sh("echo worktree > f.txt", wt.dir);
		sh("git add -A && git commit -qm 'task 05 work'", wt.dir);

		const fin = finalizeCommittedWorktrees(root, STATE_DIR, PRD_KEY, ["05"]);
		expect(fin.finalized).toEqual([]);
		expect(fin.conflicts["05"]).toBeTruthy();
		// worktree preserved for manual resolution
		expect(fs.existsSync(wt.dir)).toBe(true);
	});
});

describe("createWorktree resume reuse under symlinked paths", () => {
	it("reuses an existing worktree when the project path contains a symlink", () => {
		// macOS /tmp → /private/tmp style symlink: git porcelain reports the
		// REAL path, path.join keeps the literal one. Reuse must still match.
		const realBase = fs.mkdtempSync(path.join(os.tmpdir(), "ralpi-wt-real-"));
		const link = path.join(realBase, "link");
		fs.mkdirSync(path.join(realBase, "repo"));
		fs.symlinkSync(path.join(realBase, "repo"), link);
		const symRoot = link;

		makeRepo(symRoot);
		// Sanity: this is genuinely a symlink situation.
		expect(fs.realpathSync(symRoot)).not.toBe(symRoot);

		const wt = createWorktree(
			symRoot,
			STATE_DIR,
			"01",
			PRD_KEY,
			undefined,
			"task one",
		)!;
		commitInWorktree(wt, "a.txt", "task 01 work");

		// Resume: createWorktree again must REUSE the registered worktree
		// (same dir), not fail and fall through to the main repo.
		const reused = createWorktree(
			symRoot,
			STATE_DIR,
			"01",
			PRD_KEY,
			undefined,
			"task one",
		)!;
		expect(reused.dir).toBe(fs.realpathSync(wt.dir));

		const fin = finalizeCommittedWorktrees(symRoot, STATE_DIR, PRD_KEY, ["01"]);
		expect(fin.finalized).toEqual(["01"]);
		expect(masterHasFile(fs.realpathSync(symRoot), "a.txt")).toBe(true);
	});
});

describe("worktreeHasPreservableWork", () => {
	it("returns true for a worktree with committed work ahead of main", () => {
		const wt = createWorktree(
			root,
			STATE_DIR,
			"01",
			PRD_KEY,
			undefined,
			"task one",
		)!;
		commitInWorktree(wt, "a.txt", "task 01 work");
		expect(worktreeHasPreservableWork(root, wt)).toBe(true);
	});

	it("returns true for a worktree with uncommitted changes", () => {
		const wt = createWorktree(
			root,
			STATE_DIR,
			"01",
			PRD_KEY,
			undefined,
			"task one",
		)!;
		sh("echo x > junk.txt", wt.dir);
		expect(worktreeHasPreservableWork(root, wt)).toBe(true);
	});

	it("returns false for an empty fresh worktree", () => {
		const wt = createWorktree(
			root,
			STATE_DIR,
			"01",
			PRD_KEY,
			undefined,
			"task one",
		)!;
		expect(worktreeHasPreservableWork(root, wt)).toBe(false);
	});
});
