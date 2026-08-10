#!/usr/bin/env bun
/**
 * port-to-omp.mjs — regenerate the omp port of ralpi from this repo.
 *
 * The omp port is "base + patch layer"; this script IS the patch layer. This
 * repo is the single source of truth; ~/.omp/agent/extensions/ralpi (or
 * --out) is a generated artifact. Every op asserts its target and fails
 * loudly on base drift — never silently producing a stale port.
 *
 * Usage:
 *   bun port-to-omp.mjs                # write ~/.omp/agent/extensions/ralpi
 *   bun port-to-omp.mjs --out <dir>    # write elsewhere (CI: the omp repo clone)
 *
 * CI: .gitea/workflows/port-to-omp.yml clones the omp-ralpi repo and
 * runs this script into it, then commits + pushes when the port changed.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, isAbsolute, dirname, basename } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const HOME = homedir();
const PI = join(HOME, ".pi", "agent", "extensions");
const OMP = join(HOME, ".omp", "agent", "extensions");

const SKIP = new Set([
  "port-to-omp.mjs",
  ".gitea",
  ".github",
  "node_modules",
  ".git",
  ".DS_Store",
  ".pi-lens",
  "bun.lock",
  "package-lock.json",
  "dist",
]);

const OMP_SDK = "17.2.12";

// ─── helpers ────────────────────────────────────────────────────────────────

function assertEdit(src, from, to, file, label = "") {
  const idx = src.indexOf(from);
  if (idx === -1) {
    throw new Error(
      `[${file}] target not found${label ? ` (${label})` : ""}:\n${from.slice(0, 300)}`,
    );
  }
  return src.slice(0, idx) + to + src.slice(idx + from.length);
}

function replaceAll(src, from, to, file, label) {
  const parts = src.split(from);
  if (parts.length === 1) {
    throw new Error(`[${file}] target not found${label ? ` (${label})` : ""}:\n${from.slice(0, 300)}`);
  }
  return parts.join(to);
}

function reEdit(src, re, to, file, label) {
  const out = src.replace(re, to);
  if (out === src) {
    throw new Error(`[${file}] regex matched nothing (${label}): ${re}`);
  }
  return out;
}

function reAll(src, re, to, file, label) {
  let count = 0;
  const out = src.replace(re, (...args) => {
    count++;
    return typeof to === "function" ? to(...args) : to;
  });
  if (count === 0) {
    throw new Error(`[${file}] regex matched nothing (${label}): ${re}`);
  }
  return out;
}

/** Run a list of ops over a file's text. op = {from,to} | {re,to,label}. */
function applyOps(src, ops, file) {
  for (const op of ops) {
    if ("from" in op) {
      src = op.all ? replaceAll(src, op.from, op.to, file, op.label) : assertEdit(src, op.from, op.to, file, op.label);
    } else {
      src = op.all ? reAll(src, op.re, op.to, file, op.label) : reEdit(src, op.re, op.to, file, op.label);
    }
  }
  return src;
}

function mirrorTree(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  cpSync(srcDir, dstDir, {
    recursive: true,
    force: true,
    filter: (p) => !SKIP.has(p.split("/").pop()),
  });
  // drop stale files in dst that no longer exist in src; keep .git* intact
  for (const rel of walk(dstDir)) {
    if (rel.startsWith(".git")) continue;
    if (!existsSync(join(srcDir, rel))) rmSync(join(dstDir, rel), { force: true, recursive: true });
  }
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    // walk to the nearest existing ancestor and realpath it, then re-append
    const tail = [];
    let cur = resolve(p);
    for (;;) {
      try {
        return join(realpathSync(cur), ...tail);
      } catch {}
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

function assertDstOutsideSrc(srcDir, dstDir) {
  const rel = relative(real(srcDir), real(dstDir));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(
      `refusing to port into a subdirectory of the source: ${dstDir} is inside ${srcDir}`
    );
  }
}function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p).map((r) => join(entry.name, r)));
    else out.push(entry.name);
  }
  return out;
}

const SPECIFIERS = [
  ["@earendil-works/pi-coding-agent", "@oh-my-pi/pi-coding-agent"],
  ["@earendil-works/pi-tui", "@oh-my-pi/pi-tui"],
  ["@earendil-works/pi-ai", "@oh-my-pi/pi-ai"],
  ["@earendil-works/pi-agent-core", "@oh-my-pi/pi-agent-core"],
];

function rewriteSpecifiers(src) {
  for (const [from, to] of SPECIFIERS) src = src.split(from).join(to);
  return src;
}

// ─── package.json transforms ────────────────────────────────────────────────

function pkgName(piName) {
  if (piName.startsWith("@mikefreno/")) return piName.replace(/^@mikefreno\//, "@mikefreno/omp-");
  return `@mikefreno/omp-${piName}`;
}

function reorder(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}


const PKG_RULES = {
    order: ["name", "version", "description", "keywords", "author", "license", "homepage", "repository", "bugs", "files", "scripts", "engines", "omp", "dependencies", "publishConfig", "devDependencies"],
    transform(p) {
      p.name = pkgName(p.name);
      p.keywords = ["omp", "omp-extension", ...p.keywords.slice(2)];
      delete p.scripts.prepublishOnly;
      p.engines.bun = ">=1.3.14";
      p.omp = p.pi;
      delete p.pi;
      delete p.omp.prompts;
      delete p.peerDependencies;
      p.devDependencies = {
        "@oh-my-pi/pi-coding-agent": OMP_SDK,
        "@oh-my-pi/pi-tui": OMP_SDK,
        ...p.devDependencies,
      };
    },
  };
function transformPkg() {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  if (!raw.pi) throw new Error('expected "pi" manifest key in package.json');
  const rule = PKG_RULES;
  rule.transform(raw);
  const ordered = reorder(raw, rule.order);
  return JSON.stringify(ordered, null, 2) + "\n";
}
const README_STUB = `# ralpi (omp port)

Execute tasks from task files using DAG-based dependency resolution.

## Install

\`\`\`sh
omp install @mikefreno/omp-ralpi
\`\`\`

This is the omp port of [Mike/ralpi](https://git.freno.me/Mike/ralpi), regenerated automatically from the source repo. See the source repo for full documentation.
`;

const FILE_RULES = {
    "src/utils.ts": [
      {
        from:
          'import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";\nimport {\n  createAgentSession,\n  DefaultResourceLoader,\n  getAgentDir,\n  SessionManager,\n  SettingsManager,\n  type ModelRuntime,\n} from "@oh-my-pi/pi-coding-agent";',
        to:
          'import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";\nimport type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";\nimport {\n  AgentRegistry,\n  createAgentSession,\n  getAgentDir,\n  SessionManager,\n  Settings,\n} from "@oh-my-pi/pi-coding-agent";',
        label: "import block",
      },
      { from: "/** Path to the global ralpi config under the user's Pi home directory. */", to: "/** Path to the global ralpi config under the user's omp home directory. */" },
      { from: '  process.env.HOME || "/tmp",\n  ".pi",\n  "ralpi",', to: '  process.env.HOME || "/tmp",\n  ".omp",\n  "ralpi",', label: "GLOBAL_CONFIG_PATH" },
      { from: "~/.pi/ralpi/config.yaml", to: "~/.omp/ralpi/config.yaml", all: true, label: "config path mentions" },
      {
        from:
          "  /** Parent session's model runtime. Must be passed so extension-registered\n   *  providers (e.g., neuralwatt with its streamSimple wrapper for 429\n   *  rate-limit normalization) are available. When omitted, the SDK creates\n   *  a fresh runtime from models.json only — extension providers are lost. */\n  modelRuntime?: ModelRuntime,",
        to:
          "  /** Parent session's model registry. Must be passed so extension-registered\n   *  providers (e.g., neuralwatt with its streamSimple wrapper for 429\n   *  rate-limit normalization) are available. When omitted, the SDK creates\n   *  a fresh registry from models.json only — extension providers are lost. */\n  modelRegistry?: ModelRegistry,",
        label: "modelRuntime signature",
      },
      {
        from:
          "  try {\n    // Loop sessions load the full normal pi context: extensions (so all\n    // extension-provided tools register), skills, and project context\n    // (AGENTS.md / CLAUDE.md)\n    const loader = new DefaultResourceLoader({\n      cwd,\n      agentDir: getAgentDir(),\n      noSkills,\n      noPromptTemplates: true,\n      noThemes: true,\n      noExtensions: false,\n      noContextFiles: false,\n    });\n    await loader.reload();\n\n    const result = await createAgentSession({\n      cwd,\n      sessionManager: SessionManager.inMemory(),\n      resourceLoader: loader,\n      settingsManager: SettingsManager.create(cwd, getAgentDir()),\n      modelRuntime,\n      // No `tools` allowlist: matches a normal pi session's tool set.\n      model: model as any,\n      thinkingLevel: thinkingLevel as any,\n    });",
        to:
          "  try {\n    // Loop sessions load the full normal omp context: extensions (so all\n    // extension-provided tools register) and project context (AGENTS.md).\n    const result = await createAgentSession({\n      cwd,\n      sessionManager: SessionManager.inMemory(cwd),\n      settingsManager: Settings.init({ cwd, agentDir: getAgentDir() }),\n      // Loop sessions intentionally load extensions (no disableExtensionDiscovery),\n      // plus skills and project context via default discovery.\n      skills: noSkills ? [] : undefined,\n      promptTemplates: [],\n      // No `tools` allowlist: matches a normal omp session's tool set.\n      model: model as any,\n      thinkingLevel: thinkingLevel as any,\n      modelRegistry,\n      agentRegistry: new AgentRegistry(),\n    });",
        label: "runAgentSession body",
      },
    ],
    "index.ts": [
      {
        from:
          'import type {\n\tExtensionAPI,\n\tExtensionContext,\n} from "@oh-my-pi/pi-coding-agent";',
        to:
          'import type {\n\tExtensionAPI,\n\tExtensionContext,\n\tSessionStartEvent,\n} from "@oh-my-pi/pi-coding-agent";',
        label: "SessionStartEvent import",
      },
      {
        from: '\tpi.on("session_start", async (event, ctx) => {\n\t\tif (event.reason !== "reload") return;',
        to:
          '\tpi.on("session_start", async (event: SessionStartEvent, ctx) => {\n\t\t// omp\'s SessionStartEvent has no reason/reload field; the in_progress-task\n\t\t// check below already scopes recovery to genuinely interrupted loops (a\n\t\t// completed loop has no in_progress tasks), so recovery runs on any start\n\t\t// where a stalled loop marker exists.',
        label: "session_start handler",
      },
    ],
    "src/executor.ts": [
      {
        from:
          'import type {\n\tExtensionContext,\n\tModelRuntime,\n\tAgentSessionEvent,\n} from "@oh-my-pi/pi-coding-agent";',
        to:
          'import type {\n\tExtensionContext,\n\tAgentSessionEvent,\n} from "@oh-my-pi/pi-coding-agent";',
        label: "ModelRuntime import removal",
      },
      { from: "(ctx.modelRegistry as any).runtime as ModelRuntime,", to: "ctx.modelRegistry,", all: true, label: "modelRegistry pass-through" },
      { from: "\t// Pi's built-in retry (via SettingsManager) handles transient HTTP errors\n\t// with exponential backoff WITHIN a single prompt. Ralpi adds two layers on", to: "\t// The agent's built-in retry handles transient HTTP errors with exponential\n\t// backoff WITHIN a single prompt. Ralpi adds two layers on", label: "retry comment" },
      {
        from:
          '\t\tcase "find":\n\t\t\treturn sanitizeLabel(`${a.path ?? "."} — ${a.glob ?? "*"}`);\n\t\tcase "ls":\n\t\t\treturn sanitizeLabel(truncateMiddle(String(a.path ?? "."), 60));',
        to: '\t\tcase "glob":\n\t\t\treturn sanitizeLabel(`${a.path ?? "."} — ${a.glob ?? "*"}`);',
        label: "tool labeler find/ls",
      },
    ],
    "src/task-manager-prompt.ts": [
      {
        from:
          'import * as fs from "node:fs";\nimport * as path from "node:path";\nimport { stripFrontmatter } from "@oh-my-pi/pi-coding-agent";\n\nconst TEMPLATE_REL = path.join("prompts", "task-manager.md");',
        to:
          'import * as fs from "node:fs";\nimport * as path from "node:path";\n\nconst TEMPLATE_REL = path.join("prompts", "task-manager.md");\n\n/**\n * Strip leading YAML frontmatter (--- delimited) from template content.\n * Local port of the helper omp does not export from the package root.\n */\nfunction stripFrontmatter(content: string): string {\n  const m = /^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/.exec(content);\n  return m ? content.slice(m[0].length) : content;\n}',
        label: "vendor stripFrontmatter",
      },
    ],

  };

// ─── main ───────────────────────────────────────────────────────────────────

const OUT_DEFAULT = join(homedir(), ".omp", "agent", "extensions", "ralpi");

function portExtension() {
  const srcDir = import.meta.dir;
  const dstDir = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : OUT_DEFAULT;
  if (!dstDir) throw new Error("--out requires a directory argument");
  if (!existsSync(srcDir)) throw new Error(`no base extension at ${srcDir}`);

  assertDstOutsideSrc(srcDir, dstDir);
  console.log(`== ${srcDir} -> ${dstDir}`);
  mirrorTree(srcDir, dstDir);

  for (const rel of walk(dstDir)) {
    const p = join(dstDir, rel);
    if (!existsSync(p)) continue;
    if (rel.endsWith(".ts")) {
      let text = readFileSync(p, "utf8");
      text = rewriteSpecifiers(text);
      if (FILE_RULES[rel]) text = applyOps(text, FILE_RULES[rel], rel);
      writeFileSync(p, text);
    } else if (rel === "package.json") {
      writeFileSync(p, transformPkg());
    } else if (rel === "README.md") {
      writeFileSync(p, README_STUB);
    } else if (rel.endsWith(".md")) {
      let text = readFileSync(p, "utf8");
      if (FILE_RULES[rel]) text = applyOps(text, FILE_RULES[rel], rel);
      writeFileSync(p, text);
    }
  }
  console.log("== bun install (regenerates bun.lock + node_modules)");
  execSync("bun install", { cwd: dstDir, stdio: "inherit" });
  console.log("== done");
}

portExtension();
