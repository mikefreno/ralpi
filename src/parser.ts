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

function parseFioFormat(content: string, sourcePath: string, sourceDir: string): Project {
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
    if (/^##\s/.test(line) && !/^##\s+Tasks/.test(line) && !/^##\s+Dependencies/.test(line)) {
      inTasks = false;
      inDeps = false;
      continue;
    }

    if (inTasks) {
      const match = line.match(/^-+\s+\[([ ~x!-])\]\s+(\d+)\s+[—–-]\s+(.+?)(?:\s*→\s*`([^`]+)`)?/);
      if (match) {
        const [, , id, title, file] = match;
        tasks.push({
          id: `0${id}`,
          title: title.trim(),
          description: undefined,
          file: file || undefined,
          status: charToStatus(match[1]),
          dependencies: [],
        });
      }
    }

    if (inDeps) {
      const depMatch = line.match(/^(\d+)\s*->\s*(\d+)/);
      if (depMatch) {
        const [, from, to] = depMatch;
        const fromId = `0${from}`;
        const toId = `0${to}`;
        if (!dependencies[fromId]) dependencies[fromId] = [];
        dependencies[fromId].push(toId);
      }
    }
  }

  // Extract exit criteria
  const exitCriteria: string[] = [];
  const exitIdx = lines.findIndex(l => /^##\s+Exit\s+Criteria/i.test(l));
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

  return { tasks, dependencies, sourcePath, sourceDir, exitCriteria, objective };
}

// ─── Simple Checkbox Parser ──────────────────────────────────────────────────

function parseSimpleCheckbox(content: string, sourcePath: string, sourceDir: string): Project {
  const tasks: Task[] = [];
  const lines = content.split("\n");
  let idx = 0;

  for (const line of lines) {
    const match = line.match(/^-+\s+\[([ ~x!-])\]\s+(.+)$/);
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

function parseYaml(content: string, sourcePath: string, sourceDir: string): Project {
  // Lazy-load yaml (may not be installed)
  let YAML: typeof import("yaml");
  try {
    YAML = require("yaml");
  } catch {
    throw new Error("YAML parsing requires the 'yaml' package. Run: npm install yaml");
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
export function updateTaskInFile(filePath: string, taskId: string, status: Task["status"]): void {
  let content = fs.readFileSync(filePath, "utf-8");
  const char = statusToChar(status);

  // Try Fio numbered format first
  const fioPattern = new RegExp(
    `(^-\\s+\\[)([ ~x!-])(\\]\\s+${escapeRegex(taskId)}\\s*[—–-])`,
    "m"
  );
  if (fioPattern.test(content)) {
    content = content.replace(fioPattern, `$1${char}$3`);
    fs.writeFileSync(filePath, content, "utf-8");
    return;
  }

  // Try simple checkbox format
  const simplePattern = new RegExp(
    `(-\\s+\\[)([ ~x!-])(\\]\\s+${escapeRegex(taskId)}`,
    "m"
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
  const tasks = project.tasks.map(t => ({ ...t, dependencies: [...t.dependencies] }));
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const taskFiles = new Map(
    tasks.filter(t => t.file).map(t => [path.resolve(project.sourceDir, t.file!), t])
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

function charToStatus(char: string): Task["status"] {
  switch (char) {
    case " ": return "pending";
    case "~": return "in_progress";
    case "x": return "completed";
    case "!": return "failed";
    case "-": return "skipped";
    default: return "pending";
  }
}

function statusToChar(status: Task["status"]): string {
  switch (status) {
    case "pending": return " ";
    case "in_progress": return "~";
    case "completed": return "x";
    case "failed": return "!";
    case "skipped": return "-";
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
