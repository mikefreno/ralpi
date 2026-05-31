import * as fs from "node:fs";
import * as path from "node:path";
import type { Task, Project } from "./types";

// ─── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Parse a task file (markdown or YAML) into a Project structure.
 * Supports:
 * - Fio README format (numbered tasks with dependency graph)
 * - Simple checkbox format (- [ ] task)
 * - YAML format (tasks: [...])
 */
export function parseTaskFile(filePath: string): Project {
	const absolutePath = path.resolve(filePath);
	const content = fs.readFileSync(absolutePath, "utf-8");
	const ext = path.extname(filePath).toLowerCase();
	const dir = path.dirname(absolutePath);

	if (ext === ".yaml" || ext === ".yml") {
		return parseYaml(content, absolutePath, dir);
	}

	// Markdown: detect format
	if (hasDependenciesSection(content)) {
		return parseFioFormat(content, absolutePath, dir);
	}
	return parseSimpleCheckbox(content, absolutePath, dir);
}

// ─── Fio Format Parser ───────────────────────────────────────────────────────

function hasDependenciesSection(content: string): boolean {
	return /^##\s+Dependencies\s*$/m.test(content);
}

function parseFioFormat(
	content: string,
	sourcePath: string,
	sourceDir: string,
): Project {
	const lines = content.split("\n");
	const tasks: Task[] = [];
	const dependencies: Record<string, string[]> = {};
	let inTasks = false;
	let inDeps = false;

	for (const line of lines) {
		if (/^##\s+Tasks\s*$/m.test(line)) {
			inTasks = true;
			inDeps = false;
			continue;
		}
		if (/^##\s+Dependencies\s*$/m.test(line)) {
			inTasks = false;
			inDeps = true;
			continue;
		}
		if (
			/^##\s/.test(line) &&
			!/^##\s+Tasks/.test(line) &&
			!/^##\s+Dependencies/.test(line)
		) {
			inTasks = false;
			inDeps = false;
			continue;
		}

		if (inTasks) {
			// Match all tasks on a line (supports compact single-line formats)
			const taskPattern =
				/-+\s+\[(.)\]\s+(\d+)\s+[—–:-]\s+(.+?)(?:\s+(?=-+\s+\[)|\s*→\s*`([^`]+)`|$)/g;
			let match: RegExpExecArray | null;
			while ((match = taskPattern.exec(line)) !== null) {
				const [, status, id, title, file] = match;
				const timeoutMs = parseTimeoutFromLine(line);
				tasks.push({
					id: `0${id}`,
					title: title.trim(),
					description: undefined,
					file: file || undefined,
					status: charToStatus(status),
					dependencies: [],
					timeoutMs,
					index: tasks.length,
				});
			}
		}

		if (inDeps) {
			// Format 2: Arrow notation with multiple targets
			// "01 -> 02,03,06 (description)" means 02, 03, 06 depend on 01
			const arrowMatch = line.match(/^(\d+)\s*->\s*([\d,\s]+?)(?:\s*\(|$)/);
			if (arrowMatch) {
				const [, from, targets] = arrowMatch;
				const fromId = `0${from}`;
				const targetIds = targets
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t)
					.map((t) => `0${t}`);

				// Each target depends on the source
				for (const toId of targetIds) {
					if (!dependencies[toId]) dependencies[toId] = [];
					dependencies[toId].push(fromId);
				}
			}

			// Format 1: Natural language "X depends on A, B, C"
			const dependsMatch = line.match(/^(\d+)\s+depends\s+on\s+([\d,\s]+)/i);
			if (dependsMatch) {
				const [, taskId, depsList] = dependsMatch;
				const taskIdPadded = `0${taskId}`;
				const depIds = depsList
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t)
					.map((t) => `0${t}`);

				if (!dependencies[taskIdPadded]) dependencies[taskIdPadded] = [];
				dependencies[taskIdPadded].push(...depIds);
			}

			// Parse meta blocks for task configuration (timeout, etc.)
			const metaMatch = line.match(
				/^0?(\d+)\s+\[timeout\]\s*=?\s*(\d+)(?:m|min|s|ms)?/i,
			);
			if (metaMatch) {
				const [, taskId, value, unit] = metaMatch;
				const task = tasks.find((t) => t.id === `0${taskId}`);
				if (task) {
					task.timeoutMs = parseTimeoutValue(Number(value), unit);
				}
			}
		}
	}

	// Extract exit criteria
	const exitCriteria: string[] = [];
	const exitIdx = lines.findIndex((l) => /^##\s+Exit\s+Criteria/i.test(l));
	if (exitIdx >= 0) {
		for (let i = exitIdx + 1; i < lines.length; i++) {
			if (/^##\s/.test(lines[i])) break;
			const m = lines[i].match(/^-\s+(.+)$/);
			if (m) exitCriteria.push(m[1].trim());
		}
	}

	// Extract objective from top-level heading
	const objectiveMatch = content.match(/^#\s+(.+)$/m);
	const objective = objectiveMatch ? objectiveMatch[1].trim() : undefined;

	// Apply dependencies map to task.dependencies arrays
	for (const task of tasks) {
		if (dependencies[task.id]) {
			task.dependencies = dependencies[task.id];
		}
	}

	return {
		tasks,
		dependencies,
		sourcePath,
		sourceDir,
		exitCriteria,
		objective,
	};
}

// ─── Simple Checkbox Parser ──────────────────────────────────────────────────

function parseSimpleCheckbox(
	content: string,
	sourcePath: string,
	sourceDir: string,
): Project {
	const tasks: Task[] = [];
	const lines = content.split("\n");
	let idx = 0;

	for (const line of lines) {
		const match = line.match(/^-+\s+\[(.)\]\s+(.+)$/);
		if (match) {
			const [, statusChar, title] = match;
			const id = `${String(idx).padStart(2, "0")}`;
			tasks.push({
				id,
				title: title.trim(),
				status: charToStatus(statusChar),
				dependencies: [],
			});
			idx++;
		}
	}

	return { tasks, dependencies: {}, sourcePath, sourceDir };
}

// ─── YAML Parser ─────────────────────────────────────────────────────────────

function parseYaml(
	content: string,
	sourcePath: string,
	sourceDir: string,
): Project {
	// Lazy-load yaml (may not be installed)
	let YAML: typeof import("yaml");
	try {
		YAML = require("yaml");
	} catch {
		throw new Error(
			"YAML parsing requires the 'yaml' package. Run: npm install yaml",
		);
	}

	const doc = YAML.parse(content);
	const tasks: Task[] = [];

	if (doc.tasks && Array.isArray(doc.tasks)) {
		doc.tasks.forEach((t: any, idx: number) => {
			tasks.push({
				id: t.id || `${String(idx).padStart(2, "0")}`,
				title: t.title || t.name || `Task ${idx}`,
				description: t.description,
				file: t.file,
				status: (t.status as Task["status"]) || "pending",
				dependencies: t.depends_on || t.dependencies || [],
				parallelGroup: t.parallel_group,
				timeoutMs: parseTimeoutFromMeta(t.timeout),
				index: idx,
			});
		});
	}

	return {
		tasks,
		dependencies: doc.dependencies || {},
		sourcePath,
		sourceDir,
		exitCriteria: doc.exit_criteria || doc.exitCriteria,
		objective: doc.objective,
	};
}

// ─── Task Spec Reader ────────────────────────────────────────────────────────

/**
 * Read the detailed task specification from a task file
 */
export function readTaskSpec(taskDir: string, taskFile: string): string {
	const fullPath = path.resolve(taskDir, taskFile);
	if (!fs.existsSync(fullPath)) return "";
	return fs.readFileSync(fullPath, "utf-8");
}

// ─── Task File Updater ───────────────────────────────────────────────────────

/**
 * Update task status in the source markdown file
 */
export function updateTaskInFile(
	filePath: string,
	taskId: string,
	status: Task["status"],
): void {
	let content = fs.readFileSync(filePath, "utf-8");
	const char = statusToChar(status);

	// Try Fio numbered format first
	const fioPattern = new RegExp(
		`(^-\\s+\\[)(.)(\\]\\s+${escapeRegex(taskId)}\\s*[—–-])`,
		"m",
	);
	if (fioPattern.test(content)) {
		content = content.replace(fioPattern, `$1${char}$3`);
		fs.writeFileSync(filePath, content, "utf-8");
		return;
	}

	// Try simple checkbox format
	const simplePattern = new RegExp(
		`(-\\s+\\[)(.)(\\]\\s+${escapeRegex(taskId)})`,
		"m",
	);
	if (simplePattern.test(content)) {
		content = content.replace(simplePattern, `$1${char}$3`);
		fs.writeFileSync(filePath, content, "utf-8");
	}
}

// ─── Auto-Detect Dependencies ────────────────────────────────────────────────

/**
 * Auto-detect dependencies by analyzing task file references
 */
export function autoDetectDependencies(project: Project): Project {
	const tasks = project.tasks.map((t) => ({
		...t,
		dependencies: [...t.dependencies],
	}));
	const taskFiles = new Map(
		tasks
			.filter((t) => t.file)
			.map((t) => [path.resolve(project.sourceDir, t.file!), t]),
	);

	for (const [filePath, task] of taskFiles) {
		if (!fs.existsSync(filePath)) continue;
		const content = fs.readFileSync(filePath, "utf-8");

		// Check if this task's file references another task's file
		for (const [file, refTask] of taskFiles) {
			if (refTask.id === task.id) continue;
			if (content.includes(file) || content.includes(refTask.title)) {
				if (!task.dependencies.includes(refTask.id)) {
					task.dependencies.push(refTask.id);
				}
			}
		}
	}

	const dependencies: Record<string, string[]> = {};
	for (const task of tasks) {
		if (task.dependencies.length > 0) {
			dependencies[task.id] = task.dependencies;
		}
	}

	return { ...project, tasks, dependencies };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Timeout Parsing ────────────────────────────────────────────────────────

/**
 * Parse timeout from a task line (e.g., "timeout: 15m" or "# timeout=30s")
 */
function parseTimeoutFromLine(line: string): number | undefined {
	// Match patterns like "timeout: 15m", "# timeout=30s", "timeout: 5min"
	const match = line.match(/(?:timeout|timelimit)[\s:=]+(\d+)(?:m|min|s|ms)?/i);
	if (match) {
		return parseTimeoutValue(Number(match[1]), match[2]);
	}
	return undefined;
}

/**
 * Parse a timeout value with unit suffix
 */
function parseTimeoutValue(value: number, unit?: string): number {
	const u = (unit || "m").toLowerCase();
	switch (u) {
		case "ms":
			return value;
		case "s":
			return value * 1000;
		case "m":
		case "min":
			return value * 60 * 1000;
		default:
			return value * 60 * 1000; // default to minutes
	}
}

/**
 * Parse timeout from YAML meta field (string or number)
 * Supports: "15m", "30s", "5min", 15 (minutes), 900000 (ms)
 */
function parseTimeoutFromMeta(
	timeout: string | number | undefined,
): number | undefined {
	if (timeout === undefined) return undefined;

	if (typeof timeout === "number") {
		// Assume minutes if < 1000, milliseconds if >= 1000
		return timeout < 1000 ? timeout * 60 * 1000 : timeout;
	}

	const match = timeout.match(/^(\d+)(ms|s|m|min)?$/i);
	if (match) {
		return parseTimeoutValue(Number(match[1]), match[2]);
	}

	return undefined;
}

function charToStatus(char: string): Task["status"] {
	switch (char) {
		case " ":
			return "pending";
		case "~":
			return "in_progress";
		case "x":
			return "completed";
		case "!":
			return "failed";
		case "-":
			return "skipped";
		default:
			return "pending";
	}
}

function statusToChar(status: Task["status"]): string {
	switch (status) {
		case "pending":
			return " ";
		case "in_progress":
			return "~";
		case "completed":
			return "x";
		case "failed":
			return "!";
		case "skipped":
			return "-";
	}
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
