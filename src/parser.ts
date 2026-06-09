import * as fs from "node:fs";
import * as path from "node:path";
import type { Task, Project, ParallelGroup, Phase } from "./types";

// Lazy-loaded yaml package
let YAML_module: typeof import("yaml") | undefined;
function loadYaml(): typeof import("yaml") {
	if (YAML_module) return YAML_module;
	try {
		YAML_module = require("yaml");
	} catch {
		throw new Error(
			"YAML parsing requires the 'yaml' package. Run: npm install yaml",
		);
	}
	return YAML_module!;
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Parse a task file (markdown or YAML) into a Project structure.
 * Supports:
 * - Fio README format (numbered tasks with dependency graph)
 * - Phased format (## Phase N — Title sections with tasks and dependencies)
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
	if (hasDependenciesSection(content) || hasPhaseHeadings(content)) {
		return parseFioFormat(content, absolutePath, dir);
	}
	return parseSimpleCheckbox(content, absolutePath, dir);
}

// ─── Fio Format Parser ───────────────────────────────────────────────────────

/** Match both markdown heading (## Dependencies) and plain heading (Dependencies). */
const DEP_HEADING_RE = /^(?:##\s+)?Dependencies\s*$/m;
/** Match both markdown heading (## Tasks) and plain heading (Tasks). */
const TASK_HEADING_RE = /^(?:##\s+)?Tasks\s*$/m;
/** Match other markdown headings (## Something). */
const ANY_MD_HEADING_RE = /^##\s/;
/** Match phase headings: ## Phase 1 — Push-to-Talk MVP */
const PHASE_HEADING_RE = /^\s*##\s+Phase\s+(\d+)\s*[—–:-]\s*(.+)$/i;
/** Detect plain phase headings too: Phase 1 — Title (no ##) */
const PHASE_HEADING_PLAIN_RE = /^Phase\s+(\d+)\s*[—–:-]\s*(.+)$/i;
/**
 * Detect a plain (non-markdown) section heading like "Exit criteria".
 * A plain heading must:
 *   - Start with a letter
 *   - Contain only letters and spaces
 *   - Have no colons (avoids matching "Objective:" and "Status legend:")
 *   - Not be a task/dep line (doesn't start with "-")
 */
function isPlainSectionHeader(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length > 0 && /^[A-Za-z][A-Za-z\s]*$/.test(trimmed);
}

function hasDependenciesSection(content: string): boolean {
	return DEP_HEADING_RE.test(content);
}

function hasPhaseHeadings(content: string): boolean {
	return PHASE_HEADING_RE.test(content) || PHASE_HEADING_PLAIN_RE.test(content);
}

function parseFioFormat(
	content: string,
	sourcePath: string,
	sourceDir: string,
): Project {
	const lines = content.split("\n");
	const tasks: Task[] = [];
	const dependencies: Record<string, string[]> = {};
	const parallelGroups: ParallelGroup[] = [];
	const phases: Phase[] = [];
	let currentPhase: number | null = null;
	let currentPhaseTitle = "";
	let inTasks = false;
	let inDeps = false;

	for (const line of lines) {
		// Check for phase headings first
		const phaseMatch =
			line.match(PHASE_HEADING_RE) || line.match(PHASE_HEADING_PLAIN_RE);
		if (phaseMatch) {
			// Save previous phase if exists
			if (currentPhase !== null) {
				const phaseTaskIds = tasks
					.filter((t) => t.phase === currentPhase)
					.map((t) => t.id);
				if (phaseTaskIds.length > 0) {
					phases.push({
						number: currentPhase,
						title: currentPhaseTitle,
						taskIds: phaseTaskIds,
					});
				}
			}
			// Start new phase
			currentPhase = parseInt(phaseMatch[1], 10);
			currentPhaseTitle = phaseMatch[2].trim();
			inTasks = true;
			inDeps = false;
			continue;
		}

		if (TASK_HEADING_RE.test(line)) {
			inTasks = true;
			inDeps = false;
			continue;
		}
		if (DEP_HEADING_RE.test(line)) {
			inTasks = false;
			inDeps = true;
			continue;
		}
		// Reset state on any other section heading — both ##-style and plain
		// BUT NOT phase headings (already handled above)
		if (
			(ANY_MD_HEADING_RE.test(line) || isPlainSectionHeader(line)) &&
			!TASK_HEADING_RE.test(line) &&
			!DEP_HEADING_RE.test(line) &&
			!PHASE_HEADING_RE.test(line) &&
			!PHASE_HEADING_PLAIN_RE.test(line)
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
					id: id.padStart(2, "0"),
					title: title.trim(),
					description: undefined,
					file: file || undefined,
					status: charToStatus(status),
					dependencies: [],
					timeoutMs,
					index: tasks.length,
					phase: currentPhase ?? undefined,
				});
			}
		}

		if (inDeps) {
			// Arrow notation (supports both -> and unicode \u2192)
			// "01 -> 02,03,06" means 02, 03, 06 depend on 01
			// "02 \u2192 08" — single arrow with unicode
			// "03 \u2192 04 \u2192 05" — chained: 04 depends on 03, 05 depends on 04
			// "05, 07, 08 \u2192 13" — multi-prereq: 13 depends on 05, 07, 08
			// Supports optional markdown list prefix: "- 01 -> 02,03,06"
			const hasArrow = /->/.test(line) || /\u2192/.test(line);
			if (hasArrow) {
				// Strip optional list prefix and parenthetical description
				const cleaned = line
					.replace(/^(\s*[-*]\s+)?/, "")
					.replace(/\s*\(.*\)\s*$/, "");

				// Split on arrows to get segments
				const segments = cleaned
					.split(/->|\u2192/)
					.map((s) => s.trim())
					.filter(Boolean);

				if (segments.length >= 2) {
					for (let i = 0; i < segments.length - 1; i++) {
						// Left segment: source(s) (comma-separated)
						const fromIds = segments[i]
							.split(",")
							.map((t) => t.trim())
							.filter((t) => /^\d+$/.test(t))
							.map((t) => t.padStart(2, "0"));

						// Right segment: target(s) (comma-separated)
						const toIds = segments[i + 1]
							.split(",")
							.map((t) => t.trim())
							.filter((t) => /^\d+$/.test(t))
							.map((t) => t.padStart(2, "0"));

						for (const toId of toIds) {
							if (!dependencies[toId]) dependencies[toId] = [];
							for (const fromId of fromIds) {
								if (!dependencies[toId].includes(fromId)) {
									dependencies[toId].push(fromId);
								}
							}
						}
					}
				}
			}

			// Format 1: Natural language "X depends on A, B, C"
			// Supports optional markdown list prefix: "- 13 depends on 17, 18, 19"
			// Also handles "also depends on": "- 08 also depends on 05, 06"
			const dependsMatch = line.match(
				/^(?:\s*[-*]\s+)?(\d+)\s+(?:also\s+)?depends\s+on\s+([\d,\s]+)/i,
			);
			if (dependsMatch) {
				const [, taskId, depsList] = dependsMatch;
				const taskIdPadded = taskId.padStart(2, "0");
				const depIds = depsList
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t)
					.map((t) => t.padStart(2, "0"));

				if (!dependencies[taskIdPadded]) dependencies[taskIdPadded] = [];
				for (const depId of depIds) {
					if (!dependencies[taskIdPadded].includes(depId)) {
						dependencies[taskIdPadded].push(depId);
					}
				}
			}

			// Parse meta blocks for task configuration (timeout, etc.)
			const metaMatch = line.match(
				/^0?(\d+)\s+\[timeout\]\s*=?\s*(\d+)(?:m|min|s|ms)?/i,
			);
			if (metaMatch) {
				const [, taskId, value, unit] = metaMatch;
				const task = tasks.find((t) => t.id === taskId.padStart(2, "0"));
				if (task) {
					task.timeoutMs = parseTimeoutValue(Number(value), unit);
				}
			}

			// Format 2: "X, Y, Z can be done in parallel (label)"
			// "- 01, 02, 03, 04 can be done in parallel (Play Store prep)"
			const parallelMatch = line.match(
				/^(?:\s*[-*]\s+)?((?:0?\d+\s*,\s*)*0?\d+)\s+can\s+be\s+done\s+in\s+parallel(?:\s+\(([^)]+)\))?$/i,
			);
			if (parallelMatch) {
				const [, idsStr, label] = parallelMatch;
				const taskIds = idsStr
					.split(",")
					.map((t) => t.trim())
					.filter((t) => /^\d+$/.test(t))
					.map((t) => t.padStart(2, "0"));

				if (taskIds.length > 0) {
					parallelGroups.push({
						index: parallelGroups.length,
						label: label ? label.trim() : undefined,
						taskIds,
					});
				}
			}

			// Format 3: "A must be done before B, C" or "A, B must be done before C"
			// "- 21 must be done before 22, 23, 24 (backend integration foundation)"
			// "- 02, 03 must be done before 04"
			const mustBeforeMatch = line.match(
				/^(?:\s*[-*]\s+)?((?:0?\d+\s*,\s*)*0?\d+)\s+must\s+be\s+done\s+before\s+((?:0?\d+\s*,\s*)*0?\d+)(?:\s+\(([^)]+)\))?$/i,
			);
			if (mustBeforeMatch) {
				const [, fromIdsStr, toIdsStr] = mustBeforeMatch;
				const fromIds = fromIdsStr
					.split(",")
					.map((t) => t.trim())
					.filter((t) => /^\d+$/.test(t))
					.map((t) => t.padStart(2, "0"));
				const toIds = toIdsStr
					.split(",")
					.map((t) => t.trim())
					.filter((t) => /^\d+$/.test(t))
					.map((t) => t.padStart(2, "0"));

				// Each "to" task depends on ALL "from" tasks
				for (const toId of toIds) {
					if (!dependencies[toId]) dependencies[toId] = [];
					for (const fromId of fromIds) {
						if (!dependencies[toId].includes(fromId)) {
							dependencies[toId].push(fromId);
						}
					}
				}
			}

			// Format 4: "X, Y, Z depend on A" or "X depends on A, B, C"
			// "- 22, 23, 24 depend on 21"
			// "- 05, 06 depend on 02, 03, 04"
			// "- 08 also depends on 05, 06"  ("also" is ignored)
			// Strip optional "also" before matching
			const cleanedLine = line.replace(/\balso\b/i, "");
			const dependOnMatch = cleanedLine.match(
				/^(?:\s*[-*]\s+)?((?:0?\d+\s*,\s*)*0?\d+)\s+depend(?:s)?\s+on\s+((?:0?\d+\s*,\s*)*0?\d+)(?:\s+\(([^)]+)\))?$/i,
			);
			if (dependOnMatch) {
				const [, fromIdsStr, toIdsStr] = dependOnMatch;
				const fromIds = fromIdsStr
					.split(",")
					.map((t) => t.trim())
					.filter((t) => /^\d+$/.test(t))
					.map((t) => t.padStart(2, "0"));
				const toIds = toIdsStr
					.split(",")
					.map((t) => t.trim())
					.filter((t) => /^\d+$/.test(t))
					.map((t) => t.padStart(2, "0"));

				// Each "from" task depends on ALL "to" tasks
				for (const fromId of fromIds) {
					if (!dependencies[fromId]) dependencies[fromId] = [];
					for (const toId of toIds) {
						if (!dependencies[fromId].includes(toId)) {
							dependencies[fromId].push(toId);
						}
					}
				}
			}
		}
	}

	// Save final phase if we were in one
	if (currentPhase !== null) {
		const phaseTaskIds = tasks
			.filter((t) => t.phase === currentPhase)
			.map((t) => t.id);
		if (phaseTaskIds.length > 0) {
			phases.push({
				number: currentPhase,
				title: currentPhaseTitle,
				taskIds: phaseTaskIds,
			});
		}
	}

	// Add implicit phase-boundary dependencies
	// First task of each phase (except phase 1) depends on last task of previous phase
	if (phases.length > 1) {
		for (let i = 1; i < phases.length; i++) {
			const prevPhase = phases[i - 1];
			const currPhase = phases[i];
			if (prevPhase.taskIds.length === 0 || currPhase.taskIds.length === 0)
				continue;

			const lastTaskOfPrevPhase =
				prevPhase.taskIds[prevPhase.taskIds.length - 1];
			const firstTaskOfCurrPhase = currPhase.taskIds[0];

			// Add dependency if not already present
			if (!dependencies[firstTaskOfCurrPhase]) {
				dependencies[firstTaskOfCurrPhase] = [];
			}
			if (!dependencies[firstTaskOfCurrPhase].includes(lastTaskOfPrevPhase)) {
				dependencies[firstTaskOfCurrPhase].push(lastTaskOfPrevPhase);
			}
		}
	}

	// Extract exit criteria — detect both ## Exit Criteria and plain Exit criteria
	const exitCriteria: string[] = [];
	const exitCriteriaRe = /^(?:##\s+)?Exit\s+Criteria/i;
	const exitIdx = lines.findIndex((l) => exitCriteriaRe.test(l));
	if (exitIdx >= 0) {
		for (let i = exitIdx + 1; i < lines.length; i++) {
			// Stop at any new section heading (##-style or plain)
			if (/^##\s/.test(lines[i]) || isPlainSectionHeader(lines[i])) break;
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

	// Apply parallelGroup to tasks
	for (const group of parallelGroups) {
		for (const taskId of group.taskIds) {
			const task = tasks.find((t) => t.id === taskId);
			if (task) {
				task.parallelGroup = group.index;
			}
		}
	}

	return {
		tasks,
		dependencies,
		parallelGroups: parallelGroups.length > 0 ? parallelGroups : undefined,
		phases: phases.length > 0 ? phases : undefined,
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
	const YAML = loadYaml();
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
 * Update task status in the source file (markdown or YAML).
 *
 * Handles three formats:
 * 1. Fio numbered format: `- [ ] 01 – Title` — matches by task number in the file
 * 2. Simple checkbox: `- [ ] Title` — matches by checkbox position (index)
 * 3. YAML: uses `yaml` library to parse, update, and stringify
 */
export function updateTaskInFile(
	filePath: string,
	taskId: string,
	status: Task["status"],
): void {
	const ext = path.extname(filePath).toLowerCase();

	// Handle YAML format
	if (ext === ".yaml" || ext === ".yml") {
		updateTaskInYaml(filePath, taskId, status);
		return;
	}

	let content = fs.readFileSync(filePath, "utf-8");
	const char = statusToChar(status);

	// Strategy 1: Fio numbered format — match by explicit task ID in the file
	// Try both padded (01) and raw (1) variations.
	// When the task ID is already zero-padded (e.g., "01"), skip the raw ID
	// to avoid partial matches ("1" matching the second digit of "01").
	const idPatterns = new Set([escapeRegex(taskId)]);
	if (!taskId.startsWith("0")) {
		const rawId = parseInt(taskId, 10).toString();
		idPatterns.add(escapeRegex(rawId));
	}

	for (const idPattern of idPatterns) {
		const fioRegex = new RegExp(
			`(^-\\s+\\[)(.)(\\]\\s+${idPattern}\\s*[—–:-])`,
			"m",
		);
		const match = content.match(fioRegex);
		if (match) {
			content = content.replace(fioRegex, `$1${char}$3`);
			fs.writeFileSync(filePath, content, "utf-8");
			return;
		}
	}

	// Strategy 2: Simple checkbox by position (task IDs are zero-padded indices)
	const targetIndex = parseInt(taskId, 10);
	if (!isNaN(targetIndex)) {
		const lines = content.split("\n");
		let checkboxIdx = 0;
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^(\s*-+\s+\[)(.)(\].*)$/);
			if (m) {
				if (checkboxIdx === targetIndex) {
					lines[i] = m[1] + char + m[3];
					fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
					return;
				}
				checkboxIdx++;
			}
		}
	}
}

/**
 * Update task status in a YAML task file using the yaml library's
 * Document API, which preserves comments and formatting.
 *
 * Matches by explicit `id` field first, then falls back to
 * position-based matching (for files without explicit IDs).
 */
function updateTaskInYaml(
	filePath: string,
	taskId: string,
	status: Task["status"],
): void {
	const YAML = loadYaml();
	const content = fs.readFileSync(filePath, "utf-8");
	const doc = YAML.parseDocument(content);
	const tasks = doc.get("tasks");
	if (!tasks || !YAML.isSeq(tasks)) return;

	const rawId = parseInt(taskId, 10).toString();

	// Strategy 1: Match by explicit id field
	for (const item of tasks.items) {
		if (!YAML.isMap(item)) continue;
		const idVal = item.get("id");
		if (idVal === undefined || idVal === null) continue;
		const idStr = String(idVal);
		if (idStr === taskId || idStr === rawId) {
			item.set("status", status);
			fs.writeFileSync(filePath, String(doc), "utf-8");
			return;
		}
	}

	// Strategy 2: Fall back to position-based matching
	// (for YAML files without explicit id fields)
	const targetIndex = parseInt(taskId, 10);
	if (!isNaN(targetIndex) && targetIndex < tasks.items.length) {
		const item = tasks.items[targetIndex];
		if (YAML.isMap(item)) {
			item.set("status", status);
			fs.writeFileSync(filePath, String(doc), "utf-8");
		}
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
