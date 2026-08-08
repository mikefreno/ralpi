/**
 * Tests for the noise-filtered diff engine (src/diff.ts).
 * Covers: per-file +/− parsing, excluded-file split, totals excluding noise,
 * malformed-chunk guard, isExcluded reasons, and configurable overrides.
 */

import { describe, test, expect } from "bun:test";
import {
	parseDiff,
	filterNoise,
	isExcluded,
	compileIgnorePatterns,
	EXCLUDED_PATTERNS,
} from "../src/diff";

/** A synthetic unified diff mixing code, a lockfile, a minified file, and a binary. */
const SYNTH_DIFF = [
	"diff --git a/src/index.ts b/src/index.ts",
	"index 111..222 100644",
	"--- a/src/index.ts",
	"+++ b/src/index.ts",
	"@@ -1,2 +1,4 @@",
	' import { foo } from "./foo";',
	"+export const baz = 1;",
	"+export const qux = 2;",
	"-foo();",
	"+bar();",
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
	"diff --git a/dist/foo.min.js b/dist/foo.min.js",
	"index 111..222 100644",
	"--- a/dist/foo.min.js",
	"+++ b/dist/foo.min.js",
	"@@ -1 +1 @@",
	"-var a=1;",
	"+var a=2;",
	"",
	"diff --git a/assets/logo.png b/assets/logo.png",
	"index 111..222 100644",
	"Binary files differ",
].join("\n");

describe("parseDiff", () => {
	test("splits included vs excluded files and totals only included", () => {
		const summary = parseDiff(SYNTH_DIFF);

		// Included: only src/index.ts (code). Lockfile, minified, binary excluded.
		expect(summary.files).toHaveLength(1);
		expect(summary.files[0]).toEqual({
			path: "src/index.ts",
			linesAdded: 3,
			linesRemoved: 1,
			ext: "ts",
		});

		expect(summary.excluded).toHaveLength(3);
		const byPath = new Map(
			summary.excluded.map((f) => [f.path, f]),
		);
		expect(byPath.get("package-lock.json")).toMatchObject({
			linesAdded: 3,
			linesRemoved: 0,
			reason: "lockfile",
		});
		expect(byPath.get("dist/foo.min.js")).toMatchObject({
			linesAdded: 1,
			linesRemoved: 1,
			reason: "minified asset",
		});
		expect(byPath.get("assets/logo.png")).toMatchObject({
			linesAdded: 0,
			linesRemoved: 0,
			reason: "binary/media asset",
		});

		// Totals exclude the noise files.
		expect(summary.totalAdded).toBe(3);
		expect(summary.totalRemoved).toBe(1);
	});

	test("returns empty summary for an empty diff", () => {
		const summary = parseDiff("");
		expect(summary.files).toHaveLength(0);
		expect(summary.excluded).toHaveLength(0);
		expect(summary.totalAdded).toBe(0);
		expect(summary.totalRemoved).toBe(0);
	});

	test("skips malformed chunks without a/… b/ header without crashing", () => {
		const malformed =
			"diff --git weird-line\nindex 111..222\n--- a/x\n+++ b/x\n+x\n" +
			"\n" +
			"diff --git a/src/ok.ts b/src/ok.ts\n--- a/src/ok.ts\n+++ b/src/ok.ts\n+ok\n";
		const summary = parseDiff(malformed);
		// Only the well-formed chunk is counted.
		expect(summary.files).toHaveLength(1);
		expect(summary.files[0].path).toBe("src/ok.ts");
		expect(summary.totalAdded).toBe(1);
	});

	test("does not count +++/--- header lines as additions/removals", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -0,0 +1,2 @@",
			"+one",
			"+two",
		].join("\n");
		const summary = parseDiff(diff);
		expect(summary.files[0].linesAdded).toBe(2);
		expect(summary.files[0].linesRemoved).toBe(0);
	});
});

describe("isExcluded", () => {
	test("returns the right reason per pattern", () => {
		expect(isExcluded("package-lock.json")).toBe("lockfile");
		expect(isExcluded("yarn.lock")).toBe("lockfile");
		expect(isExcluded("src/app.min.js")).toBe("minified asset");
		expect(isExcluded("src/styles.min.css")).toBe("minified asset");
		expect(isExcluded("build/out.js")).toBe("build output");
		expect(isExcluded("node_modules/foo/index.js")).toBe("dependency");
		expect(isExcluded("vendor/lib.bundle.js")).toBe("vendored dependency");
		expect(isExcluded("assets/icon.svg")).toBe("binary/media asset");
		expect(isExcluded("src/api.generated.ts")).toBe("generated file");
		expect(isExcluded("test/__snapshots__/x.snap")).toBe("snapshot");
		expect(isExcluded("dist/x.js.map")).toBe("source map");
	});

	test("returns undefined for review-relevant files", () => {
		expect(isExcluded("src/foo.ts")).toBeUndefined();
		expect(isExcluded("src/index.ts")).toBeUndefined();
	});

	test("merges caller-supplied extra patterns", () => {
		expect(isExcluded("src/data.foo", [/\.foo$/])).toBe("extra ignore pattern");
		expect(isExcluded("src/data.foo")).toBeUndefined();
	});

	test("EXCLUDED_PATTERNS covers lockfiles, min, generated, snap, map, build, vendor, binaries", () => {
		for (const pat of [
			"package-lock.json",
			"src/app.min.js",
			"src/thing.generated.ts",
			"x.snap",
			"x.js.map",
			"dist/bundle.js",
			"node_modules/a/b.js",
			"vendor/x",
			"a.png",
			"f.woff2",
		]) {
			const hit = EXCLUDED_PATTERNS.some((r) => r.pattern.test(pat));
			expect(hit, `${pat} should be covered by a default rule`).toBe(true);
		}
	});
});

describe("filterNoise", () => {
	test("re-emits only included-file chunks", () => {
		const filtered = filterNoise(SYNTH_DIFF);
		expect(filtered).toContain("diff --git a/src/index.ts");
		expect(filtered).not.toContain("package-lock.json");
		expect(filtered).not.toContain("foo.min.js");
		expect(filtered).not.toContain("logo.png");
	});

	test("returns empty when every file is noise", () => {
		const onlyNoise = [
			"diff --git a/package-lock.json b/package-lock.json",
			"--- a/package-lock.json",
			"+++ b/package-lock.json",
			"+x",
		].join("\n");
		expect(filterNoise(onlyNoise)).toBe("");
	});
});

describe("configurable noise rules", () => {
	test("extraPatterns excludes a matching file from the review diff", () => {
		const diff = [
			"diff --git a/src/foo.ts b/src/foo.ts",
			"--- a/src/foo.ts",
			"+++ b/src/foo.ts",
			"+keep",
			"diff --git a/src/data.foo b/src/data.foo",
			"--- a/src/data.foo",
			"+++ b/src/data.foo",
			"+drop",
		].join("\n");
		const opts = { extraPatterns: compileIgnorePatterns(["\\.foo$"]) };
		const summary = parseDiff(diff, opts);
		expect(summary.files.map((f) => f.path)).toEqual(["src/foo.ts"]);
		expect(summary.excluded.map((f) => [f.path, f.reason])).toEqual([
			["src/data.foo", "extra ignore pattern"],
		]);
		expect(filterNoise(diff, opts)).not.toContain("data.foo");
	});

	test("ignorePaths keeps an excluded-by-default file in scope", () => {
		const diff = [
			"diff --git a/package-lock.json b/package-lock.json",
			"--- a/package-lock.json",
			"+++ b/package-lock.json",
			"+a",
			"+b",
			"+c",
		].join("\n");
		const opts = { ignorePaths: ["package-lock.json"] };
		const summary = parseDiff(diff, opts);
		expect(summary.files).toHaveLength(1);
		expect(summary.files[0].path).toBe("package-lock.json");
		expect(summary.excluded).toHaveLength(0);
		expect(summary.totalAdded).toBe(3);
		expect(filterNoise(diff, opts)).toContain("package-lock.json");
	});

	test("default behavior unchanged when overrides are unset", () => {
		const summary = parseDiff(SYNTH_DIFF);
		expect(summary.files[0].path).toBe("src/index.ts");
		expect(summary.totalAdded).toBe(3);
	});

	test("compileIgnorePatterns skips invalid regexes", () => {
		const compiled = compileIgnorePatterns(["\\.foo$", "(", "ok$"]);
		expect(compiled.length).toBe(2);
	});
});
