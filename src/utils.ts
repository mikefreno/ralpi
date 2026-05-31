import * as fs from "node:fs";
import * as path from "node:path";
import type {
	RalpiConfig,
	PRDProgress,
	ProgressState,
	ToolUsage,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

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

// ─── Async Agent Session ────────────────────────────────────────────────────

// ─── Progress Discovery ─────────────────────────────────────────────────────

/**
 * Find the nearest .ralpi/progress.json by walking up from the given directory.
 * For a specific sourcePath, finds the matching PRD entry.
 */
export function findProgressFile(
	startDir: string,
	sourcePath?: string,
): { path: string; state: ProgressState; prdKey?: string } | null {
	let current = path.resolve(startDir);
	const root = path.parse(current).root;

	while (current !== root) {
		const candidate = path.join(current, ".ralpi", "progress.json");
		if (fs.existsSync(candidate)) {
			try {
				const raw = fs.readFileSync(candidate, "utf-8");
				const state = JSON.parse(raw) as ProgressState;

				// If looking for a specific source path, find matching PRD
				if (sourcePath && state.prds) {
					const resolvedSource = path.resolve(sourcePath);
					for (const [key, prd] of Object.entries(state.prds)) {
						if (path.resolve(prd.sourcePath) === resolvedSource) {
							return { path: candidate, state, prdKey: key };
						}
					}
					// No matching PRD found, continue walking up
					current = path.dirname(current);
					continue;
				}

				return { path: candidate, state };
			} catch {
				return null;
			}
		}
		current = path.dirname(current);
	}

	return null;
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
			let value: string | boolean | number = match[2].trim();

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
	defaults: RalpiConfig,
	overrides: Record<string, any>,
): RalpiConfig {
	const result = { ...defaults };

	for (const [key, value] of Object.entries(overrides)) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			(result as any)[key] = { ...(defaults as any)[key], ...value };
		} else {
			(result as any)[key] = value;
		}
	}

	return result as RalpiConfig;
}

/**
 * Load configuration from .ralpi/config.yaml or return defaults
 */
export function loadConfig(projectDir: string): RalpiConfig {
	const configPath = path.join(projectDir, ".ralpi", "config.yaml");

	// Return defaults silently when config file does not exist
	if (!fs.existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const content = fs.readFileSync(configPath, "utf-8");
		// Simple YAML parsing (key: value format)
		const config = parseSimpleYaml(content);
		return mergeConfig(DEFAULT_CONFIG, config);
	} catch {
		// Malformed config — fall back to defaults silently
		return { ...DEFAULT_CONFIG };
	}
}

// ─── Task Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a task argument to a file path.
 * Strips leading `@` (from autocomplete) before resolution.
 */
export function resolveTaskArg(arg: string, cwd: string): string {
	// Strip leading @ from autocomplete
	const cleanArg = arg.startsWith("@") ? arg.slice(1) : arg;

	const candidates = [
		path.resolve(cwd, cleanArg),
		path.resolve(cwd, cleanArg + ".md"),
		path.resolve(cwd, cleanArg + ".yaml"),
		path.resolve(cwd, cleanArg + ".yml"),
	];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}

	// Try looking for README.md in the arg directory
	try {
		if (fs.statSync(path.resolve(cwd, cleanArg)).isDirectory()) {
			const readme = path.resolve(cwd, cleanArg, "README.md");
			if (fs.existsSync(readme)) return readme;
		}
	} catch {
		// Directory doesn't exist, fall through to error
	}

	throw new Error(
		`Task file not found: ${cleanArg}\nSearched: ${candidates.join("\n  ")}`,
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
 * Format progress status for display. Accepts a single PRDProgress entry.
 */
export function formatProgressStatus(state: PRDProgress): string {
	const lines: string[] = [];
	const tasks = state.tasks;
	const total = Object.keys(tasks).length;
	const completed = Object.values(tasks).filter(
		(t) => t.status === "completed",
	).length;
	const failed = Object.values(tasks).filter(
		(t) => t.status === "failed",
	).length;
	const inProgress = Object.values(tasks).filter(
		(t) => t.status === "in_progress",
	).length;

	lines.push("## Progress");
	lines.push("");
	lines.push(
		`Total: ${total} | Completed: ${completed} | Failed: ${failed} | In Progress: ${inProgress}`,
	);
	lines.push("");

	for (const [id, info] of Object.entries(tasks)) {
		const statusIcon =
			info.status === "completed"
				? "[x]"
				: info.status === "in_progress"
					? "[~]"
					: info.status === "failed"
						? "[!]"
						: "[ ]";

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

/**
 * Format progress status for all PRDs in a ProgressState.
 */
export function formatAllPRDsStatus(state: ProgressState): string {
	const prds = state.prds;
	if (!prds || Object.keys(prds).length <= 1) {
		// Single PRD — use simple format
		const prd = prds
			? Object.values(prds)[0]
			: (state as unknown as PRDProgress);
		return formatProgressStatus(prd);
	}

	const lines: string[] = [];
	lines.push("## Progress (all PRDs)");
	lines.push("");

	for (const [key, prd] of Object.entries(prds)) {
		const tasks = prd.tasks;
		const total = Object.keys(tasks).length;
		const completed = Object.values(tasks).filter(
			(t) => t.status === "completed",
		).length;
		const failed = Object.values(tasks).filter(
			(t) => t.status === "failed",
		).length;
		const inProgress = Object.values(tasks).filter(
			(t) => t.status === "in_progress",
		).length;

		lines.push(`### ${key}`);
		lines.push(`Source: ${path.relative(process.cwd(), prd.sourcePath)}`);
		lines.push(
			`Total: ${total} | Completed: ${completed} | Failed: ${failed} | In Progress: ${inProgress}`,
		);
		lines.push("");

		for (const [id, info] of Object.entries(tasks)) {
			const statusIcon =
				info.status === "completed"
					? "[x]"
					: info.status === "in_progress"
						? "[~]"
						: info.status === "failed"
							? "[!]"
							: "[ ]";

			const duration = info.durationMs
				? ` (${formatDuration(info.durationMs)})`
				: "";

			lines.push(`- ${statusIcon} ${id}${duration}`);

			if (info.error) {
				lines.push(`  Error: ${info.error}`);
			}
		}

		lines.push("");
	}

	return lines.join("\n");
}

// ─── Async Agent Session ────────────────────────────────────────────────────

/**
 * Run a task prompt through an in-process Pi agent session (async, non-blocking).
 *
 * Unlike the old spawnPi() which used spawnSync and froze the TUI,
 * this uses createAgentSession from the Pi SDK, keeping the event loop
 * responsive and allowing progress updates during task execution.
 */
export async function runAgentSession(
	taskPrompt: string,
	cwd: string,
	timeoutMs: number,
	onEvent?: (event: AgentSessionEvent) => void,
	signal?: AbortSignal,
	sessionFile?: string,
): Promise<{
	success: boolean;
	text: string;
	error?: string;
	toolUsage: ToolUsage;
	stopReason?: string;
	events: AgentSessionEvent[];
}> {
	const toolUsage: ToolUsage = {
		read: 0,
		write: 0,
		edit: 0,
		bash: 0,
		other: 0,
	};
	// Stream events to file instead of accumulating in memory.
	// Accumulating caused "Invalid string length" crashes when
	// JSON.stringify(output.events, null, 2) produced 300+ MB strings.
	const eventStream = sessionFile
		? fs.createWriteStream(sessionFile, { flags: "a" })
		: null;

	// Wire timeout via abort signal
	const timeoutHandle = setTimeout(() => {
		if (sessionRef?.session) sessionRef.session.agent.abort();
	}, timeoutMs);

	const sessionRef: {
		session?: Awaited<ReturnType<typeof createAgentSession>>["session"];
	} = {};

	try {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noSkills: false,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const result = await createAgentSession({
			cwd,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: loader,
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		});
		sessionRef.session = result.session;

		// Wire external abort signal
		const abortHandler = () => result.session.agent.abort();
		signal?.addEventListener("abort", abortHandler, { once: true });

		let finalText = "";
		let errorMessage: string | undefined;
		let stopReason: string | undefined;

		const unsubscribe = result.session.subscribe((event) => {
			// Stream event to file (avoids accumulating 300+ MB in memory)
			if (eventStream) {
				eventStream.write(JSON.stringify(event) + "\n");
			}
			onEvent?.(event);

			if (event.type === "message_end") {
				const message = event.message as {
					role?: string;
					content?: unknown;
					stopReason?: string;
					errorMessage?: string;
				};
				if (message.role !== "assistant") return;
				if (message.stopReason) stopReason = message.stopReason;
				if (message.errorMessage) errorMessage = message.errorMessage;
				const text = extractAssistantText(message.content);
				if (text) finalText = text;
			}

			if (event.type === "tool_execution_start") {
				const name = event.toolName;
				if (name in toolUsage) {
					(toolUsage as unknown as Record<string, number>)[name]++;
				} else {
					toolUsage.other++;
				}
			}
		});

		if (signal?.aborted) throw new Error("Aborted before prompt");

		await result.session.prompt(taskPrompt);
		await result.session.agent.waitForIdle();

		unsubscribe();
		result.session.dispose();
		signal?.removeEventListener("abort", abortHandler);
		clearTimeout(timeoutHandle);

		// Flush and close the event stream before returning
		if (eventStream) {
			await new Promise<void>((resolve) => eventStream.end(resolve));
		}

		if (errorMessage && !finalText) {
			return {
				success: false,
				text: "",
				error: errorMessage,
				toolUsage,
				stopReason,
				events: [], // streamed to file
			};
		}

		return {
			success: true,
			text: finalText.trim(),
			toolUsage,
			stopReason,
			events: [], // streamed to file
		};
	} catch (error) {
		clearTimeout(timeoutHandle);
		if (eventStream && !eventStream.destroyed) {
			eventStream.end();
		}
		return {
			success: false,
			text: "",
			error: error instanceof Error ? error.message : String(error),
			toolUsage,
			events: [], // streamed to file
		};
	} finally {
		sessionRef.session?.dispose();
	}
}

/**
 * Extract assistant text from message content (text blocks only).
 */
function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: string; text?: string } =>
				!!c &&
				typeof c === "object" &&
				(c as { type?: string }).type === "text",
		)
		.map((c) => (c as { text?: string }).text ?? "")
		.join("");
}

// ─── Git Commit Capture ──────────────────────────────────────────────────────

/**
 * Capture recent git commits made during task execution
 * Returns commit messages and a summary string
 */
export function captureGitCommits(projectDir: string): {
	commitMessages: string[];
	commitSummary: string;
} {
	const { execSync } = require("node:child_process");

	try {
		// Check if this is a git repo
		execSync("git rev-parse --git-dir", { cwd: projectDir, stdio: "pipe" });
	} catch {
		return { commitMessages: [], commitSummary: "" };
	}

	const commitMessages: string[] = [];
	let commitSummary = "";

	try {
		// Get recent commits (last 5) with short hash and subject
		const output = execSync("git log --oneline -5 --no-decorate", {
			cwd: projectDir,
			encoding: "utf-8",
		}).trim();

		if (output) {
			const lines = output.split("\n").filter((l: string) => l.trim());
			for (const line of lines) {
				// Format: "abc1234 Commit message"
				const parts = line.split(" ", 2);
				if (parts.length >= 2) {
					commitMessages.push(parts[1]);
				}
			}

			// Build summary from commit subjects
			commitSummary = commitMessages.slice(0, 3).join("; ");
			if (commitMessages.length > 3) {
				commitSummary += ` (+${commitMessages.length - 3} more)`;
			}
		}
	} catch {
		// Git command failed, return empty
	}

	return { commitMessages, commitSummary };
}
