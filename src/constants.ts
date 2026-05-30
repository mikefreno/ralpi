import type { RalphConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

export { DEFAULT_CONFIG };

// CLI
export const SLASH_COMMAND = "/ralph";
export const COMMANDS = ["run", "plan", "status", "resume", "next", "reset"] as const;

// Task file detection
export const TASK_FILE_NAMES = [
  "README.md",
  "PRD.md",
  "tasks.md",
  "tasks.yaml",
  "tasks.yml",
] as const;

// Reflection parsing
export const REFLECTION_HEADER = "## REFLECTION";
export const REFLECTION_PATTERN = /##\s*REFLECTION\s*\n([\s\S]*?)(?=\n```|$)/i;

// Pi subprocess
export const DEFAULT_PI_ARGS = ["--no-stream"] as const;
