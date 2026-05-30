import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { RalphConfig, ProgressState, Task } from "./types";
import { DEFAULT_CONFIG } from "./types";

// ─── Directory Helpers ───────────────────────────────────────────────────────

/**
 * Ensure a directory exists, creating it recursively if needed
 */
export function ensureDir(dirPath: string): void {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

/**
 * Write file content, creating parent directories if needed
 */
export function writeFileSafe(filePath: string, content: string): void {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, content, "utf-8");
}

// ─── Command Helpers ─────────────────────────────────────────────────────────

/**
 * Check if a command exists in PATH
 */
export function commandExists(command: string): boolean {
	try {
		const { execSync } = require("node:child_process");
		execSync(`which ${command}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the path to the pi executable
 */
export function getPiPath(): string {
	// Check if PI_PATH environment variable is set
	const envPath = process.env.PI_PATH;
	if (envPath && fs.existsSync(envPath)) {
		return envPath;
	}

	// Try to find pi in PATH
	if (commandExists("pi")) {
		return "pi";
	}

	throw new Error(
		"pi executable not found. Set PI_PATH or ensure pi is in PATH.",
	);
}

// ─── Config ──────────────────────────────────────────────────────────────────

function parseSimpleYaml(content: string): Record<string, any> {
	const result: Record<string, any> = {};
	const lines = content.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const match = trimmed.match(/^([^:]+):\s*(.+)$/);
		if (match) {
			const key = match[1].trim();
			let value = match[2].trim();

			// Parse booleans
			if (value === "true") value = true;
			else if (value === "false") value = false;
			// Parse numbers
			else if (/^\d+$/.test(value)) value = parseInt(value, 10);
			else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);

			result[key] = value;
		}
	}

	return result;
}

/**
 * Deep merge configuration objects
 */
function mergeConfig(
	defaults: RalphConfig,
	overrides: Record<string, any>,
): RalphConfig {
	const result = { ...defaults };

	for (const [key, value] of Object.entries(overrides)) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			(result as any)[key] = { ...(defaults as any)[key], ...value };
		} else {
			(result as any)[key] = value;
		}
	}

	return result as RalphConfig;
}

/**
 * Load configuration from .ralph/config.yaml or return defaults
 */
export function loadConfig(projectDir: string): RalphConfig {
	const configPath = path.join(projectDir, ".ralph", "config.yaml");

	try {
		const content = fs.readFileSync(configPath, "utf-8");
		// Simple YAML parsing (key: value format)
		const config = parseSimpleYaml(content);
		return mergeConfig(DEFAULT_CONFIG, config);
	} catch (error) {
		console.warn("Failed to load .ralph/config.yaml, using defaults:", error);
		return { ...DEFAULT_CONFIG };
	}
}

// ─── Task Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a task argument to a file path
 */
export function resolveTaskArg(
	arg: string,
	cwd: string,
): string {
	const candidates = [
		path.resolve(cwd, arg),
		path.resolve(cwd, arg + ".md"),
		path.resolve(cwd, arg + ".yaml"),
		path.resolve(cwd, arg + ".yml"),
	];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}

	// Try looking for README.md in the arg directory
	if (fs.statSync(path.resolve(cwd, arg)).isDirectory()) {
		const readme = path.resolve(cwd, arg, "README.md");
		if (fs.existsSync(readme)) return readme;
	}

	throw new Error(
		`Task file not found: ${arg}\nSearched: ${candidates.join("\n  ")}`,
	);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${seconds}s`;
}

/**
 * Format progress status for display
 */
export function formatProgressStatus(state: ProgressState): string {
	const lines: string[] = [];
	const tasks = state.tasks;
	const total = Object.keys(tasks).length;
	const completed = Object.values(tasks).filter(
		t => t.status === "completed",
	).length;
	const failed = Object.values(tasks).filter(
		t => t.status === "failed",
	).length;
	const inProgress = Object.values(tasks).filter(
		t => t.status === "in_progress",
	).length;

	lines.push("## Progress");
	lines.push("");
	lines.push(`Total: ${total} | Completed: ${completed} | Failed: ${failed} | In Progress: ${inProgress}`);
	lines.push("");

	for (const [id, info] of Object.entries(tasks)) {
		const statusIcon =
			info.status === "completed" ? "[x]" :
			info.status === "in_progress" ? "[~]" :
			info.status === "failed" ? "[!]" :
			"[ ]";

		const duration = info.durationMs
			? ` (${formatDuration(info.durationMs)})`
			: "";

		lines.push(`- ${statusIcon} ${id}${duration}`);

		if (info.error) {
			lines.push(`  Error: ${info.error}`);
		}
	}

	lines.push("");
	lines.push(`Started: ${state.startedAt}`);
	lines.push(`Updated: ${state.lastUpdatedAt}`);
	lines.push(`Paused: ${state.paused ? "yes" : "no"}`);

	return lines.join("\n");
}

// ─── Pi Subprocess ───────────────────────────────────────────────────────────

/**
 * Spawn a pi subprocess with the given prompt file
 */
export function spawnPi(
	promptFile: string,
	piPath: string,
	args?: string[],
): { stdout: string; stderr: string; code: number | null } {
	const spawnArgs = ["--prompt", promptFile, ...(args || [])];

	const result = spawnSync(piPath, spawnArgs, {
		encoding: "utf-8",
		timeout: 60 * 60 * 1000, // 1 hour
		maxBuffer: 10 * 1024 * 1024, // 10MB
	});

	return {
		stdout: result.stdout || "",
		stderr: result.stderr || "",
		code: result.status,
	};
}

/**
 * Extract text content from pi event stream output
 */
export function extractTextFromEvent(output: string): string {
	// If output is JSON event stream, extract text fields
	if (output.startsWith("{") || output.startsWith("data:")) {
		const lines = output.split("\n");
		const texts: string[] = [];

		for (const line of lines) {
			// Try to parse NDJSON events
			if (line.startsWith("data: ")) {
				try {
					const event = JSON.parse(line.slice(6));
					if (event.type === "text" && event.text) {
						texts.push(event.text);
					}
				} catch {
					texts.push(line.slice(6));
				}
			} else if (line.trim()) {
				texts.push(line);
			}
		}

		return texts.join("\n");
	}

	return output;
}
