import * as fs from "node:fs";
import * as path from "node:path";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

const TEMPLATE_REL = path.join("prompts", "task-manager.md");

/**
 * Parse command arguments respecting quoted strings (bash-style).
 * Ported from pi's core/prompt-templates.js so the task-manager template
 * receives the same arg-splitting a real `/task-manager` invocation would.
 */
function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Substitute argument placeholders in template content.
 * Faithful port of pi's substituteArgs (core/prompt-templates.js):
 *   - $1, $2, ...        positional args
 *   - $@ / $ARGUMENTS    all args joined
 *   - ${N:-default}      positional N with default when missing/empty
 *   - ${@:-default}      all args with default when empty
 *   - ${@:N} / ${@:N:L}  bash-style slicing
 *
 * Replacement runs once over the template only; argument/default values
 * containing patterns like $1 or $@ are NOT recursively substituted.
 */
function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultTarget) {
        const value =
          defaultTarget === "@" || defaultTarget === "ARGUMENTS"
            ? allArgs
            : args[parseInt(defaultTarget, 10) - 1];
        return value ? value : defaultValue;
      }
      if (sliceStart) {
        let start = parseInt(sliceStart, 10) - 1; // 1-indexed → 0-indexed
        if (start < 0) start = 0;
        if (sliceLength) {
          const length = parseInt(sliceLength, 10);
          return args.slice(start, start + length).join(" ");
        }
        return args.slice(start).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") {
        return allArgs;
      }
      const index = parseInt(simple, 10) - 1;
      return args[index] ?? "";
    },
  );
}

/**
 * Load and expand the task-manager prompt template bundled with the extension.
 *
 * `pi.sendUserMessage()` sends with `expandPromptTemplates: false`, so it will
 * NOT expand a `/task-manager` invocation — and `@task-manager` is an
 * @-mention, not a template invocation anyway. We therefore read the
 * template ourselves, strip its frontmatter, substitute args ($@ etc.), and
 * return the fully-expanded prompt body ready to send as a user message.
 *
 * @param extensionDir  Absolute path to the extension root (where index.ts
 *                      lives), used to locate `prompts/task-manager.md`.
 * @param argsString    Raw argument string from the slash command (may be "").
 * @throws if the template file is missing or unreadable.
 */
export function loadTaskManagerPrompt(
  extensionDir: string,
  argsString: string,
): string {
  const templatePath = path.join(extensionDir, TEMPLATE_REL);
  const raw = fs.readFileSync(templatePath, "utf-8");
  const body = stripFrontmatter(raw);
  const args = parseCommandArgs(argsString);
  return substituteArgs(body, args).trim();
}
