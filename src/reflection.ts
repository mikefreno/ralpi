import * as fs from "node:fs";
import * as path from "node:path";
import type { Reflection } from "./types";
import { REFLECTION_PATTERN } from "./constants";
import { ensureDir, writeFileSafe } from "./utils";

// ─── Extract Reflection ──────────────────────────────────────────────────────

/**
 * Extract a reflection block from pi's output text
 */
export function extractReflection(
	output: string,
	taskId: string,
	title: string,
): Reflection | null {
	const match = output.match(REFLECTION_PATTERN);
	if (!match) return null;

	const block = match[1];
	const summary = extractField(block, "SUMMARY");
	const files = extractField(block, "FILES");
	const learnings = extractList(block, "LEARNINGS");
	const blockersRaw = extractField(block, "BLOCKERS");

	const blockers =
		blockersRaw && blockersRaw.toLowerCase() !== "none"
			? blockersRaw.split(",").map(b => b.trim()).filter(Boolean)
			: undefined;

	return {
		taskId,
		title,
		summary: summary || "Task completed",
		keyLearnings: learnings || [],
		filesChanged: files
			? files.split(",").map(f => f.trim()).filter(Boolean)
			: [],
		blockers,
		timestamp: new Date().toISOString(),
	};
}

function extractField(block: string, field: string): string | null {
	const regex = new RegExp(`${field}:\\s*(.+?)$`, "im");
	const match = block.match(regex);
	return match ? match[1].trim() : null;
}

function extractList(block: string, field: string): string[] | null {
	const regex = new RegExp(`${field}:\\s*\\n((?:- .+\\n?)+)`, "im");
	const match = block.match(regex);
	if (!match) return null;
	return match[1]
		.split("\n")
		.map(l => l.replace(/^-\\s*/, "").trim())
		.filter(Boolean);
}

// ─── Save / Load Reflections ────────────────────────────────────────────────

/**
 * Save a reflection to a file
 */
export function saveReflection(
	reflectionsDir: string,
	reflection: Reflection,
): void {
	ensureDir(reflectionsDir);
	const filePath = path.join(
		reflectionsDir,
		`${reflection.taskId}.json`,
	);
	writeFileSafe(filePath, JSON.stringify(reflection, null, 2));
}

/**
 * Load a reflection from a file
 */
export function loadReflection(
	reflectionsDir: string,
	taskId: string,
): Reflection | null {
	const filePath = path.join(reflectionsDir, `${taskId}.json`);
	if (!fs.existsSync(filePath)) return null;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Reflection;
	} catch {
		return null;
	}
}

// ─── Format Reflections ──────────────────────────────────────────────────────

/**
 * Format reflections for display
 */
export function formatReflections(reflections: Reflection[]): string {
	if (reflections.length === 0) return "No reflections yet.";

	const lines: string[] = [];
	lines.push("## Task Reflections");
	lines.push("");

	for (const ref of reflections) {
		lines.push(`### ${ref.taskId}: ${ref.title}`);
		lines.push(`Summary: ${ref.summary}`);

		if (ref.keyLearnings.length > 0) {
			lines.push("Learnings:");
			for (const l of ref.keyLearnings) {
				lines.push(`  - ${l}`);
			}
		}

		if (ref.filesChanged.length > 0) {
			lines.push(`Files: ${ref.filesChanged.join(", ")}`);
		}

		if (ref.blockers && ref.blockers.length > 0) {
			lines.push(`Blockers: ${ref.blockers.join("; ")}`);
		}

		lines.push("");
	}

	return lines.join("\n");
}
