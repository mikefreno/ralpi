import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewResult, ReviewFinding, ReviewVerdict } from "./types";
import { REVIEW_PATTERN } from "./constants";
import { ensureDir, writeFileSafe } from "./utils";

// ─── Extract Structured Review ──────────────────────────────────────────────

/**
 * Extract a structured review verdict from the review agent's output text.
 * Mirrors extractReflection() — parses a `## REVIEW VERDICT` block emitted at
 * the end of the response.
 *
 * The raw text is preserved on the ReviewResult so the expanded (Ctrl+O) view
 * can still render the full free-form prose. Returns null when no verdict
 * block is found (caller falls back to free-form text handling).
 */
export function extractReview(
	output: string,
	taskId: string,
	commitHash: string,
): ReviewResult | null {
	const match = output.match(REVIEW_PATTERN);
	if (!match) return null;

	const block = match[1];
	const verdict = extractVerdict(block);
	if (!verdict) return null; // verdict is the one required field

	const summary = extractField(block, "SUMMARY") ?? "";
	const findings = extractFindings(block);

	return {
		taskId,
		verdict,
		summary: summary || verdictLabel(verdict),
		findings,
		commitHash,
		rawText: output.trim(),
		timestamp: new Date().toISOString(),
	};
}

function extractVerdict(block: string): ReviewVerdict | null {
	const raw = extractField(block, "VERDICT");
	if (!raw) return null;
	const v = raw.toLowerCase().trim();
	if (v === "pass" || v === "warn" || v === "fail") return v;
	// Tolerate common synonyms
	if (v === "warning" || v === "minor") return "warn";
	if (v === "fail" || v === "failing" || v === "blocker") return "fail";
	if (v === "ok" || v === "passing" || v === "approve") return "pass";
	return null;
}

// Allowlisted static regexes — `field` is always a known literal, but we use
// a static map rather than string interpolation so there's no dynamic regex
// construction at all (`new RegExp` from a variable trips ReDoS linters).
const FIELD_PATTERNS: Record<string, RegExp> = {
	VERDICT: /VERDICT:\s*(.+?)$/im,
	SUMMARY: /SUMMARY:\s*(.+?)$/im,
};

function extractField(block: string, field: string): string | null {
	const regex = FIELD_PATTERNS[field.toUpperCase()];
	if (!regex) return null;
	const match = block.match(regex);
	return match ? match[1].trim() : null;
}

/**
 * Parse FINDINGS: lines into structured ReviewFinding objects.
 * Each finding line is expected as:
 *   - [severity] [file:line] message
 * where severity is one of blocker|warning|nit|info.
 * Falls back gracefully — an unparseable line becomes an info-severity
 * finding with the raw line as the message.
 */
function extractFindings(block: string): ReviewFinding[] {
	// Match the FINDINGS: header, then capture all following bullet lines.
	const regex = /FINDINGS:\s*\n((?:[-*]\s+.+\n?)+)/i;
	const match = block.match(regex);
	if (!match) return [];

	const lines = match[1]
		.split("\n")
		.map((l) => l.replace(/^[-*]\s*/, "").trim())
		.filter(Boolean);

	const findings: ReviewFinding[] = [];
	const severityRe = /^\[(blocker|warning|warn|nit|info)\]\s*(.*)$/i;

	for (const line of lines) {
		const sm = line.match(severityRe);
		if (sm) {
			let sev = sm[1].toLowerCase();
			if (sev === "warn") sev = "warning";
			const rest = sm[2].trim();
			const { file, line: lineNum, message } = parseFileRef(rest);
			findings.push({
				severity: sev as ReviewFinding["severity"],
				file,
				line: lineNum,
				message,
			});
		} else {
			// No severity bracket — treat as info
			const { file, line: lineNum, message } = parseFileRef(line);
			findings.push({ severity: "info", file, line: lineNum, message });
		}
	}

	return findings;
}

/** Parse an optional `file:line` prefix from a finding message. */
function parseFileRef(rest: string): {
	file?: string;
	line?: number;
	message: string;
} {
	const m = rest.match(/^([\w./-]+):(\d+)\s*[-—]?\s*(.*)$/);
	if (m) {
		return { file: m[1], line: Number(m[2]), message: m[3].trim() || rest };
	}
	return { message: rest };
}

function verdictLabel(v: ReviewVerdict): string {
	switch (v) {
		case "pass":
			return "Commit satisfies the task requirements.";
		case "warn":
			return "Commit passes with minor issues worth addressing.";
		case "fail":
			return "Commit does not satisfy the task requirements.";
	}
}

// ─── Save / Load Structured Reviews ─────────────────────────────────────────

/**
 * Save a structured review as JSON alongside (or instead of) the markdown
 * body. Mirrors saveReflectionToFile's per-loop layout so a repo can hold
 * many loops without collisions:
 *   .ralpi/reviews/<prdKey>/<taskId>.json
 */
export function saveReviewToFile(
	sourceDir: string,
	reviewsDir: string,
	review: ReviewResult,
	prdKey: string,
): string {
	const dir = path.join(sourceDir, reviewsDir, prdKey);
	ensureDir(dir);
	const filePath = path.join(dir, `${review.taskId}.json`);
	writeFileSafe(filePath, JSON.stringify(review, null, 2));
	return filePath;
}

/**
 * Load a structured review from disk.
 */
export function loadReview(
	sourceDir: string,
	reviewsDir: string,
	taskId: string,
	prdKey: string,
): ReviewResult | null {
	const filePath = path.join(sourceDir, reviewsDir, prdKey, `${taskId}.json`);
	if (!fs.existsSync(filePath)) return null;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ReviewResult;
	} catch {
		return null;
	}
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Verdict glyph for compact display in chat headers / widgets. */
export function verdictGlyph(v: ReviewVerdict): string {
	switch (v) {
		case "pass":
			return "✓";
		case "warn":
			return "⚠";
		case "fail":
			return "✗";
	}
}

/** Short label: "PASS · 0 findings", "WARN · 2 findings", "FAIL · 3 findings" */
export function verdictSummary(review: ReviewResult): string {
	const n = review.findings.length;
	const noun = n === 1 ? "finding" : "findings";
	return `${review.verdict.toUpperCase()} · ${n} ${noun}`;
}

/**
 * Format findings as an indented markdown tree for the expanded view.
 */
export function formatFindings(review: ReviewResult): string {
	if (review.findings.length === 0) return "(no findings)";
	const lines: string[] = [];
	for (const f of review.findings) {
		const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "";
		lines.push(`  - [${f.severity}]${loc ? ` ${loc}` : ""} — ${f.message}`);
	}
	return lines.join("\n");
}
