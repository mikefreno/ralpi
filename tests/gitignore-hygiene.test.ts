import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tempDir } from "./helpers";
import { ensureRalpiIgnored } from "../src/utils";

// ─── Gitignore hygiene: ensureRalpiIgnored ──────────────────────────────────

describe("ensureRalpiIgnored", () => {
	it("creates .gitignore with .ralpi/ when absent in a git work tree", () => {
		const { dir, cleanup } = tempDir();
		try {
			fs.mkdirSync(path.join(dir, ".git"));
			expect(ensureRalpiIgnored(dir)).toBe(true);
			const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
			expect(content).toContain(".ralpi/");
		} finally {
			cleanup();
		}
	});

	it("appends .ralpi/ to an existing .gitignore without the marker", () => {
		const { dir, cleanup } = tempDir();
		try {
			fs.mkdirSync(path.join(dir, ".git"));
			fs.writeFileSync(
				path.join(dir, ".gitignore"),
				"node_modules/\n*.log\n",
				"utf8",
			);
			expect(ensureRalpiIgnored(dir)).toBe(true);
			const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
			expect(content).toContain("node_modules/");
			expect(content).toContain(".ralpi/");
		} finally {
			cleanup();
		}
	});

	it("leaves a .gitignore with the marker untouched", () => {
		const { dir, cleanup } = tempDir();
		try {
			fs.mkdirSync(path.join(dir, ".git"));
			fs.writeFileSync(path.join(dir, ".gitignore"), ".ralpi/\n", "utf8");
			expect(ensureRalpiIgnored(dir)).toBe(false);
			expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(
				".ralpi/\n",
			);
		} finally {
			cleanup();
		}
	});

	it("is a no-op outside a git work tree", () => {
		const { dir, cleanup } = tempDir();
		try {
			expect(ensureRalpiIgnored(dir)).toBe(false);
			expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("is memoized per project dir", () => {
		const { dir, cleanup } = tempDir();
		try {
			fs.mkdirSync(path.join(dir, ".git"));
			expect(ensureRalpiIgnored(dir)).toBe(true);
			// Second call: same dir already handled → no further work.
			expect(ensureRalpiIgnored(dir)).toBe(false);
			fs.writeFileSync(path.join(dir, ".gitignore"), "old\n", "utf8");
			expect(ensureRalpiIgnored(dir)).toBe(false);
			expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(
				"old\n",
			);
		} finally {
			cleanup();
		}
	});

	it("works when .git is a file (linked git worktree)", () => {
		const { dir, cleanup } = tempDir();
		try {
			fs.writeFileSync(
				path.join(dir, ".git"),
				"gitdir: /some/shared/repo\n",
				"utf8",
			);
			expect(ensureRalpiIgnored(dir)).toBe(true);
			const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
			expect(content).toContain(".ralpi/");
		} finally {
			cleanup();
		}
	});
});