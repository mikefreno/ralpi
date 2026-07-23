import * as path from "node:path";
import { ensureDir } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorktreeHandle {
	/** Absolute path to the worktree working directory. */
	dir: string;
	/** Branch name: slugified task title, or `ralpi/<prdKey>/<taskId>` as a fallback. */
	branch: string;
	/** Main repo directory (where the primary working tree lives). */
	mainDir: string;
}

export interface MergeResult {
	success: boolean;
	/** File paths that conflicted (empty when merge succeeds). */
	conflicts: string[];
	/** Human-readable status message. */
	message: string;
}

// ─── Git Helpers ─────────────────────────────────────────────────────────────

/** Run a git command, returning trimmed stdout. Returns null on failure. */
function git(args: string, cwd: string): string | null {
	const { execSync } = require("node:child_process") as {
		execSync: (cmd: string, opts: object) => string;
	};
	try {
		return execSync(`git ${args}`, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return null;
	}
}

/** Run a git command that may fail; returns { ok, stdout, stderr }. */
function gitRaw(
	args: string,
	cwd: string,
): { ok: boolean; stdout: string; stderr: string } {
	const { execSync } = require("node:child_process") as {
		execSync: (cmd: string, opts: object) => string;
	};
	try {
		const stdout = execSync(`git ${args}`, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { ok: true, stdout: stdout.trim(), stderr: "" };
	} catch (err: unknown) {
		const e = err as {
			stdout?: string;
			stderr?: string;
			message?: string;
		};
		return {
			ok: false,
			stdout: (e.stdout ?? "").toString().trim(),
			stderr: (e.stderr ?? "").toString().trim(),
		};
	}
}

/** Check if a directory is inside a git repository. */
export function isGitRepo(dir: string): boolean {
	return git("rev-parse --git-dir", dir) !== null;
}

/** Get the current HEAD commit hash of a directory. */
export function getGitHead(dir: string): string | null {
	return git("rev-parse HEAD", dir);
}

/** Get the current branch name of a directory. */
export function getCurrentBranch(dir: string): string | null {
	return git("rev-parse --abbrev-ref HEAD", dir);
}

// ─── Worktree Lifecycle ──────────────────────────────────────────────────────

/**
 * Path to the worktree directory for a given task.
 * Lives inside `.ralpi/worktrees/<prdKey>/<taskId>` in the main repo so all
 * ralpi state stays co-located and multiple loops (different PRDs) can run
 * concurrently without colliding on shared task IDs. The directory itself
 * is untracked git metadata (registered in `.git/worktrees/`), so it won't
 * pollute `git status` in the main working tree.
 */
export function worktreePath(
	mainDir: string,
	stateDir: string,
	prdKey: string,
	taskId: string,
): string {
	return path.join(mainDir, stateDir, "worktrees", prdKey, taskId);
}

/**
 * Normalise a task ID into a valid git branch suffix.
 * Zero-padded IDs like "01" are already valid; this ensures any stray
 * characters are replaced.
 */
function safeBranchSuffix(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Sanitise a free-form task title into a git-branch-safe slug.
 *
 * Lowercases, replaces runs of non-alphanumeric characters with single
 * hyphens, trims leading/trailing hyphens, and caps the length so the
 * branch name stays readable and within reasonable git limits.
 *
 * Returns an empty string when the title produces no usable slug.
 */
function slugifyTitle(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/**
 * Create a git worktree for a task.
 *
 * The worktree is created at `<mainDir>/.ralpi/worktrees/<prdKey>/<taskId>`
 * on a new branch. When `taskTitle` is provided the branch name is the slugified title
 * alone (e.g. `fix-plans-tab-grammar-casing-icons`); otherwise it falls back
 * to `ralpi/<prdKey>/<taskId>`. Based at `baseRef` (defaults to the current
 * HEAD of `mainDir`).
 *
 * The worktree directory always uses the bare `taskId` for a stable path;
 * stale-worktree cleanup identifies ralpi worktrees by that path, not by
 * branch name, so descriptive branch names are safe.
 *
 * Returns null if `mainDir` is not a git repo or the worktree creation fails.
 */
export function createWorktree(
	mainDir: string,
	stateDir: string,
	taskId: string,
	prdKey: string,
	baseRef?: string,
	taskTitle?: string,
): WorktreeHandle | null {
	if (!isGitRepo(mainDir)) return null;

	const safeId = safeBranchSuffix(taskId);
	const slug = taskTitle ? slugifyTitle(taskTitle) : "";
	const branch = slug || `ralpi/${prdKey}/${safeId}`;
	const wtDir = worktreePath(mainDir, stateDir, prdKey, taskId);

	// Prune metadata for worktree directories that no longer exist on disk
	// (e.g. from a crashed previous run that left stale `.git/worktrees/` entries).
	git("worktree prune", mainDir);

	// ── Reuse an already-registered worktree (resume) ──
	// A resumed loop skips `cleanupStaleWorktrees`, so the interrupted task's
	// worktree — and the branch carrying its committed work — survives. Reuse
	// it instead of destroying and recreating from the base ref; otherwise the
	// prior session's commits are lost and the task restarts from scratch.
	const existing = git(`worktree list --porcelain`, mainDir);
	if (existing && existing.includes(`worktree ${wtDir}`)) {
		// The worktree is registered — sanity-check it's a valid checkout.
		if (getGitHead(wtDir)) {
			return { dir: wtDir, branch, mainDir };
		}
		// Registered but broken (dir gone / checkout corrupt) — drop its
		// metadata and fall through to fresh creation below.
		git(`worktree remove --force "${wtDir}"`, mainDir);
	}

	// Fresh creation.
	const ref = baseRef ?? getGitHead(mainDir);
	if (!ref) return null;

	// Ensure the parent directory exists so `git worktree add` can create
	// the worktree directory inside it.
	ensureDir(path.dirname(wtDir));

	// Delete a stale branch if it exists from a previous run so `-b` doesn't
	// fail on the new worktree.
	git(`branch -D "${branch}"`, mainDir);

	const result = gitRaw(
		`worktree add -b "${branch}" "${wtDir}" "${ref}"`,
		mainDir,
	);
	if (!result.ok) {
		// Fall back to detached HEAD worktree if branch creation fails
		// (e.g. the branch name somehow conflicts).
		const fallback = gitRaw(
			`worktree add --detach "${wtDir}" "${ref}"`,
			mainDir,
		);
		if (!fallback.ok) return null;
	}

	return { dir: wtDir, branch, mainDir };
}

/**
 * Merge a worktree's branch back into the current branch of the main repo.
 *
 * Uses `--no-ff` to always create a merge commit, preserving the task
 * branch's history. On conflict, the merge is aborted and the conflicts
 * are returned so the caller can mark the task as failed.
 */
export function mergeWorktree(mainDir: string, branch: string): MergeResult {
	// Attempt the merge.
	const result = gitRaw(`merge --no-ff --no-edit "${branch}"`, mainDir);

	if (result.ok) {
		return {
			success: true,
			conflicts: [],
			message: `Merged ${branch} into ${getCurrentBranch(mainDir) ?? "HEAD"}`,
		};
	}

	// Merge failed — likely conflicts. Collect the list of conflicting files.
	const status = git("diff --name-only --diff-filter=U", mainDir) ?? "";
	const conflicts = status
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	// Abort the merge so the main repo's working tree is left clean.
	git("merge --abort", mainDir);

	return {
		success: false,
		conflicts,
		message:
			conflicts.length > 0
				? `Merge conflicts in: ${conflicts.join(", ")}`
				: `Merge of ${branch} failed: ${result.stderr || result.stdout}`,
	};
}

/**
 * Re-attempt a merge WITHOUT aborting on conflict.
 *
 * Unlike `mergeWorktree`, this leaves the main repo in a merge-conflict
 * state so a conflict-resolution agent can see the conflict markers in the
 * working tree and resolve them manually. The caller is responsible for
 * committing the resolved merge or aborting it.
 *
 * Returns:
 *  - `clean: true`  → merge succeeded (nothing staged to commit yet; the
 *    caller should `git commit` or `git merge --abort` to finalise)
 *  - `clean: false` → conflicts; working tree has conflict markers
 */
export function reattemptMerge(
	mainDir: string,
	branch: string,
): { clean: boolean; conflicts: string[] } {
	// Use --no-commit so even a clean merge doesn't auto-commit — the caller
	// controls when the merge commit lands.
	const result = gitRaw(`merge --no-ff --no-commit "${branch}"`, mainDir);

	if (result.ok) {
		return { clean: true, conflicts: [] };
	}

	// Merge produced conflicts — collect them but DO NOT abort.
	const status = git("diff --name-only --diff-filter=U", mainDir) ?? "";
	const conflicts = status
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return { clean: false, conflicts };
}

/** Abort an in-progress merge in the main repo. */
export function abortMerge(mainDir: string): void {
	git("merge --abort", mainDir);
}

/** Check if there are unmerged paths (conflicts) in the working tree. */
export function hasMergeConflicts(mainDir: string): boolean {
	const status = git("diff --name-only --diff-filter=U", mainDir) ?? "";
	return status.trim().length > 0;
}

/** Complete the in-progress merge by committing. Returns true on success. */
export function completeMerge(mainDir: string): boolean {
	const result = gitRaw("commit --no-edit", mainDir);
	return result.ok;
}

/**
 * Remove a worktree and delete its branch.
 *
 * Called after a successful merge to clean up. Safe to call even if the
 * worktree or branch no longer exists.
 */
export function removeWorktree(mainDir: string, wt: WorktreeHandle): void {
	git(`worktree remove --force "${wt.dir}"`, mainDir);
	git(`branch -D "${wt.branch}"`, mainDir);
	git("worktree prune", mainDir);
}

/**
 * Clean up stale worktrees from interrupted runs.
 *
 * Identifies ralpi-owned worktrees by their path living under
 * `<mainDir>/<stateDir>/worktrees/` and removes them. Called at the start
 * of a loop to ensure a clean slate. Returns the list of removed worktree
 * directories.
 *
 * When `prdKey` is provided, cleanup is scoped to
 * `<mainDir>/<stateDir>/worktrees/<prdKey>/` so that worktrees belonging to
 * other concurrently running loops (different PRDs) are left untouched.
 * When omitted, all ralpi-managed worktrees are cleaned.
 */
export function cleanupStaleWorktrees(
	mainDir: string,
	stateDir: string,
	prdKey?: string,
): string[] {
	const removed: string[] = [];

	// Prune metadata for worktree directories that no longer exist on disk.
	git("worktree prune", mainDir);

	const list = git("worktree list --porcelain", mainDir);
	if (!list) return removed;

	// Worktrees we manage live under <mainDir>/<stateDir>/worktrees/.
	// When a prdKey is given, narrow to that PRD's subdir so concurrent
	// loops (other PRDs) are not disturbed.
	const managedRoot = path.resolve(
		mainDir,
		stateDir,
		"worktrees",
		...(prdKey ? [prdKey] : []),
	);

	// Parse worktree list: each entry is `worktree <path>` followed by metadata.
	const wtLines = list
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length).trim());

	for (const wtDir of wtLines) {
		// Skip the main working tree (always first in the list).
		if (path.resolve(wtDir) === path.resolve(mainDir)) continue;

		// Only touch worktrees that live under the ralpi worktrees directory.
		const resolved = path.resolve(wtDir);
		if (
			resolved !== managedRoot &&
			!resolved.startsWith(managedRoot + path.sep)
		)
			continue;

		// Remove the worktree and its branch.
		git(`worktree remove --force "${wtDir}"`, mainDir);
		const branch = git(`rev-parse --abbrev-ref HEAD`, wtDir);
		if (branch && branch !== "HEAD" && branch !== "detached") {
			git(`branch -D "${branch}"`, mainDir);
		}
		removed.push(wtDir);
	}

	git("worktree prune", mainDir);
	return removed;
}
