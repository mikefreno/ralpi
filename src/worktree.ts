import * as path from "node:path";
import { ensureDir } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorktreeHandle {
	/** Absolute path to the worktree working directory. */
	dir: string;
	/** Branch name: `ralpi/<prdKey>/<taskId>`. */
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
 * Lives inside `.ralpi/worktrees/<taskId>` in the main repo so all ralpi
 * state stays co-located. The directory itself is untracked git metadata
 * (registered in `.git/worktrees/`), so it won't pollute `git status`
 * in the main working tree.
 */
export function worktreePath(
	mainDir: string,
	stateDir: string,
	taskId: string,
): string {
	return path.join(mainDir, stateDir, "worktrees", taskId);
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
 * Create a git worktree for a task.
 *
 * The worktree is created at `<mainDir>/.ralpi/worktrees/<taskId>` on a new
 * branch `ralpi/<prdKey>/<taskId>`, based at `baseRef` (defaults to the
 * current HEAD of `mainDir`).
 *
 * Returns null if `mainDir` is not a git repo or the worktree creation fails.
 */
export function createWorktree(
	mainDir: string,
	stateDir: string,
	taskId: string,
	prdKey: string,
	baseRef?: string,
): WorktreeHandle | null {
	if (!isGitRepo(mainDir)) return null;

	const ref = baseRef ?? getGitHead(mainDir);
	if (!ref) return null;

	const safeId = safeBranchSuffix(taskId);
	const branch = `ralpi/${prdKey}/${safeId}`;
	const wtDir = worktreePath(mainDir, stateDir, taskId);

	// Ensure the parent directory exists so `git worktree add` can create
	// the worktree directory inside it.
	ensureDir(path.dirname(wtDir));

	// Remove a stale worktree directory if one exists (e.g. from a crashed
	// previous run). `git worktree add` fails if the path already exists.
	// We prune first to clean up any metadata for removed-but-not-pruned dirs.
	git("worktree prune", mainDir);
	const existing = git(`worktree list --porcelain`, mainDir);
	if (existing && existing.includes(`worktree ${wtDir}`)) {
		// A worktree at this path is already registered — remove it.
		git(`worktree remove --force "${wtDir}"`, mainDir);
	}
	// Also delete a stale branch if it exists from a previous run.
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
export function mergeWorktree(
	mainDir: string,
	branch: string,
	taskId: string,
): MergeResult {
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
 * Lists all worktrees whose branches start with `ralpi/<prdKey>/` and
 * removes them. Called at the start of a loop to ensure a clean slate.
 * Returns the list of removed worktree directories.
 */
export function cleanupStaleWorktrees(
	mainDir: string,
	prdKey: string,
): string[] {
	const removed: string[] = [];

	// Prune metadata for worktree directories that no longer exist on disk.
	git("worktree prune", mainDir);

	const list = git("worktree list --porcelain", mainDir);
	if (!list) return removed;

	// Parse worktree list: each entry is `worktree <path>` followed by metadata.
	const wtLines = list
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length).trim());

	for (const wtDir of wtLines) {
		// Skip the main working tree (always first in the list).
		if (path.resolve(wtDir) === path.resolve(mainDir)) continue;

		// Check if this worktree is on a ralpi branch for this PRD.
		const branch = git(`rev-parse --abbrev-ref HEAD`, wtDir);
		if (!branch) continue;
		if (!branch.startsWith(`ralpi/${prdKey}/`)) continue;

		// Remove the worktree and its branch.
		git(`worktree remove --force "${wtDir}"`, mainDir);
		if (branch !== "HEAD" && branch !== "detached") {
			git(`branch -D "${branch}"`, mainDir);
		}
		removed.push(wtDir);
	}

	git("worktree prune", mainDir);
	return removed;
}
