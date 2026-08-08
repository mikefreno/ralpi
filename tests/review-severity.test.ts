/**
 * Tests for the severity taxonomy alignment in review verdict parsing
 * (src/review.ts): the `critical` token is accepted and normalized to
 * ralpi's `blocker` severity, mirroring @piex-dev/review's grading.
 */

import { describe, test, expect } from "bun:test";
import { extractReview } from "../src/review";

/** Build a full review-agent output ending in a REVIEW VERDICT block. */
function reviewOutput(findings: string[]): string {
	return [
		"Prose: looks mostly fine, a few issues to fix.",
		"## REVIEW VERDICT",
		"VERDICT: fail",
		"SUMMARY: Needs fixes.",
		"FINDINGS:",
		...findings,
	].join("\n");
}

describe("extractReview severity normalization", () => {
	test("maps critical → blocker, keeps warning/nit/info", () => {
		const out = reviewOutput([
			"- [critical] src/auth.ts:12 hardcoded secret",
			"- [warning] src/auth.ts:30 unused import",
			"- [nit] src/auth.ts:5 style",
			"- [info] src/auth.ts:1 note",
		]);
		const review = extractReview(out, "01", "abc1234");
		expect(review).not.toBeNull();
		const severities = review!.findings.map((f) => f.severity);
		expect(severities).toEqual(["blocker", "warning", "nit", "info"]);
	});

	test("normalizes the warn synonym to warning", () => {
		const out = reviewOutput(["- [warn] src/a.ts:2 thing"]);
		const review = extractReview(out, "01", "abc1234");
		expect(review!.findings[0].severity).toBe("warning");
	});

	test("uppercase CRITICAL token also maps to blocker", () => {
		const out = reviewOutput(["- [CRITICAL] src/a.ts:2 thing"]);
		const review = extractReview(out, "01", "abc1234");
		expect(review!.findings[0].severity).toBe("blocker");
	});

	test("findings without a severity are still parsed", () => {
		const out = reviewOutput(["- src/a.ts:2 plain line"]);
		const review = extractReview(out, "01", "abc1234");
		expect(review!.findings[0].severity).toBe("info");
	});
});
