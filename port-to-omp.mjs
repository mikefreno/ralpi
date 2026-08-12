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
import {
  join,
  relative,
  resolve,
  isAbsolute,
  dirname,
  basename,
} from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const HOME = homedir();
const PI = join(HOME, ".pi", "agent", "extensions");
const OMP = join(HOME, ".omp", "agent", "extensions");

const SKIP = new Set([
  "port-to-omp.mjs",
  "release-tag.sh",
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

/** Appended to op failures: the base repo is the source of truth, so a failed
 *  assertion means the source drifted and the op needs updating — never a
 *  reason to weaken the assertion. */
const DRIFT_HINT =
  "\n\nBase repo drifted since this op was written — update the op (from/to) in" +
  " port-to-omp.mjs. The verify CI job runs this script on every push, so this" +
  " should surface on the branch that introduced the drift.";

/** Point at the first divergence between an expected op target and the actual
 *  file text, with a little surrounding context. */
function driftHint(src, from) {
  const fromLines = from.split("\n");
  const srcLines = src.split("\n");
  const needle = fromLines[0].slice(0, 60);
  // indexOf failed, so no full match exists. Anchor on the occurrence of the
  // op's opening line that shares the LONGEST consecutive run with the
  // expected text — a bare `  try {` can match unrelated blocks.
  let anchor = -1;
  let bestRun = -1;
  for (let i = 0; i < srcLines.length; i++) {
    if (!srcLines[i].includes(needle)) continue;
    let run = 0;
    while (run < fromLines.length && fromLines[run] === srcLines[i + run]) run++;
    if (run > bestRun) {
      bestRun = run;
      anchor = i;
    }
  }
  if (anchor === -1) {
    return `\n\ncould not locate the op's opening line anywhere in the file:\n  ${fromLines[0]}`;
  }
  const ctx = 2;
  const i = Math.min(bestRun, fromLines.length - 1);
  const before = srcLines
    .slice(Math.max(0, anchor + i - ctx), anchor + i)
    .map((l) => `  ${l}`);
  const after = srcLines
    .slice(anchor + i + 1, anchor + i + 1 + ctx)
    .map((l) => `  ${l}`);
  return (
    `\n\nop matches at file line ${anchor + 1} for ${bestRun} line(s), then diverges at expected line ${i + 1}:\n` +
    `  expected: ${fromLines[i]}\n` +
    `  actual  : ${srcLines[anchor + i] ?? "<end of file>"}\n` +
    (before.length ? `\nactual context before:\n${before.join("\n")}\n` : "") +
    (after.length ? `\nactual context after:\n${after.join("\n")}` : "")
  );
}

function assertEdit(src, from, to, file, label = "") {
  const idx = src.indexOf(from);
  if (idx === -1) {
    throw new Error(
      `[${file}] target not found${label ? ` (${label})` : ""}${driftHint(
        src,
        from,
      )}\n` + `\nexpected target text:\n${from}${DRIFT_HINT}`,
    );
  }
  return src.slice(0, idx) + to + src.slice(idx + from.length);
}

function replaceAll(src, from, to, file, label) {
  const parts = src.split(from);
  if (parts.length === 1) {
    throw new Error(
      `[${file}] target not found${label ? ` (${label})` : ""}${driftHint(
        src,
        from,
      )}\n` + `\nexpected target text:\n${from}${DRIFT_HINT}`,
    );
  }
  return parts.join(to);
}

function reEdit(src, re, to, file, label) {
  const out = src.replace(re, to);
  if (out === src) {
    throw new Error(
      `[${file}] regex matched nothing (${label}): ${re}${DRIFT_HINT}`,
    );
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
    throw new Error(
      `[${file}] regex matched nothing (${label}): ${re}${DRIFT_HINT}`,
    );
  }
  return out;
}

/** Run a list of ops over a file's text. op = {from,to} | {re,to,label}. */
function applyOps(src, ops, file) {
  for (const op of ops) {
    if ("from" in op) {
      src = op.all
        ? replaceAll(src, op.from, op.to, file, op.label)
        : assertEdit(src, op.from, op.to, file, op.label);
    } else {
      src = op.all
        ? reAll(src, op.re, op.to, file, op.label)
        : reEdit(src, op.re, op.to, file, op.label);
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
    if (!existsSync(join(srcDir, rel)))
      rmSync(join(dstDir, rel), { force: true, recursive: true });
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
      `refusing to port into a subdirectory of the source: ${dstDir} is inside ${srcDir}`,
    );
  }
}
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory())
      out.push(...walk(p).map((r) => join(entry.name, r)));
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
  if (piName.startsWith("@mikefreno/"))
    return piName.replace(/^@mikefreno\//, "@mikefreno/omp-");
  return `@mikefreno/omp-${piName}`;
}

function reorder(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

const PKG_RULES = {
  order: [
    "name",
    "version",
    "description",
    "keywords",
    "author",
    "license",
    "homepage",
    "repository",
    "bugs",
    "files",
    "scripts",
    "engines",
    "omp",
    "dependencies",
    "publishConfig",
    "devDependencies",
  ],
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
  const raw = JSON.parse(
    readFileSync(join(import.meta.dir, "package.json"), "utf8"),
  );
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


// publish workflow emitted into the port repo so the omp package can be
// released independently (tag push or manual dispatch on the omp repo).
const PORT_PUBLISH_WORKFLOW = "name: publish\n\n# Publish this omp port package to the npm registry on version tags.\n#\n# Prerequisites:\n#   - npm automation token (publish scope) stored as the repo secret NPM_TOKEN\n#   - package name claimed on npm (@mikefreno/omp-<name>)\n#\n# Manual publish: Actions tab → Run workflow (workflow_dispatch).\n\non:\n  push:\n    tags: ['v*']\n  workflow_dispatch:\n\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n\n      - name: Setup node (npm registry auth)\n        uses: actions/setup-node@v4\n        with:\n          node-version: '22'\n          registry-url: 'https://registry.npmjs.org'\n\n      - name: Publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n        run: npm publish --access public --ignore-scripts\n";

const FILE_RULES = {
  "src/utils.ts": [
    {
      from: 'import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";\nimport {\n  createAgentSession,\n  DefaultResourceLoader,\n  getAgentDir,\n  SessionManager,\n  SettingsManager,\n  type ModelRuntime,\n} from "@oh-my-pi/pi-coding-agent";',
      to: 'import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";\nimport type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";\nimport {\n  AgentRegistry,\n  createAgentSession,\n  getAgentDir,\n  SessionManager,\n  Settings,\n} from "@oh-my-pi/pi-coding-agent";',
      label: "import block",
    },
    {
      from: "/** Path to the global ralpi config under the user's Pi home directory. */",
      to: "/** Path to the global ralpi config under the user's omp home directory. */",
    },
    {
      from: '  process.env.HOME || "/tmp",\n  ".pi",\n  "ralpi",',
      to: '  process.env.HOME || "/tmp",\n  ".omp",\n  "ralpi",',
      label: "GLOBAL_CONFIG_PATH",
    },
    {
      from: "~/.pi/ralpi/config.yaml",
      to: "~/.omp/ralpi/config.yaml",
      all: true,
      label: "config path mentions",
    },
    {
      from: "  /** Parent session's model runtime. Must be passed so extension-registered\n   *  providers (e.g., neuralwatt with its streamSimple wrapper for 429\n   *  rate-limit normalization) are available. When omitted, the SDK creates\n   *  a fresh runtime from models.json only — extension providers are lost. */\n  modelRuntime?: ModelRuntime,",
      to: "  /** Parent session's model registry. Must be passed so extension-registered\n   *  providers (e.g., neuralwatt with its streamSimple wrapper for 429\n   *  rate-limit normalization) are available. When omitted, the SDK creates\n   *  a fresh registry from models.json only — extension providers are lost. */\n  modelRegistry?: ModelRegistry,",
      label: "modelRuntime signature",
    },
    {
      from: '  try {\n    // Loop sessions load the full normal pi context: extensions (so all\n    // extension-provided tools register), skills, and project context\n    // (AGENTS.md / CLAUDE.md)\n    const loader = new DefaultResourceLoader({\n      cwd,\n      agentDir: getAgentDir(),\n      noSkills,\n      noPromptTemplates: true,\n      noThemes: true,\n      noExtensions: false,\n      noContextFiles: false,\n    });\n    await loader.reload();\n\n    // Persist sessions under the ralpi project\'s `.ralpi/sessions/` so they\n    // survive worktree removal and are findable from the main repo on resume.\n    // Worktrees live inside `<project>/.ralpi/worktrees/...`, so walking up\n    // from the agent\'s cwd always finds the main project\'s `.ralpi` first.\n    const ralpiDir = findRalpiDir(cwd);\n    const sessionDir = ralpiDir\n      ? path.join(ralpiDir, ".ralpi", "sessions")\n      : path.join(cwd, ".ralpi", "sessions");\n\n    let sessionManager: SessionManager;\n    if (resumeSessionFile && fs.existsSync(resumeSessionFile)) {\n      sessionManager = SessionManager.open(resumeSessionFile, sessionDir, cwd);\n    } else {\n      if (resumeSessionFile) {\n        console.warn(\n          `[ralpi] resume session file not found (${resumeSessionFile}) — starting a fresh session`,\n        );\n      }\n      sessionManager = SessionManager.create(cwd, sessionDir);\n    }\n\n    const result = await createAgentSession({\n      cwd,\n      sessionManager,\n      resourceLoader: loader,\n      settingsManager: SettingsManager.create(cwd, getAgentDir()),\n      modelRuntime,\n      // No `tools` allowlist: matches a normal pi session\'s tool set.\n      model: model as any,\n      thinkingLevel: thinkingLevel as any,\n    });',
      to: '  try {\n    // Loop sessions load the full normal omp context: extensions (so all\n    // extension-provided tools register) and project context (AGENTS.md).\n    // Persist sessions under the ralpi project\'s `.ralpi/sessions/` so they\n    // survive worktree removal and are findable from the main repo on resume.\n    // Worktrees live inside `<project>/.ralpi/worktrees/...`, so walking up\n    // from the agent\'s cwd always finds the main project\'s `.ralpi` first.\n    const ralpiDir = findRalpiDir(cwd);\n    const sessionDir = ralpiDir\n      ? path.join(ralpiDir, ".ralpi", "sessions")\n      : path.join(cwd, ".ralpi", "sessions");\n\n    let sessionManager: SessionManager;\n    if (resumeSessionFile && fs.existsSync(resumeSessionFile)) {\n      sessionManager = await SessionManager.open(resumeSessionFile, sessionDir, undefined, {\n        initialCwd: cwd,\n      });\n    } else {\n      if (resumeSessionFile) {\n        console.warn(\n          `[ralpi] resume session file not found (${resumeSessionFile}) — starting a fresh session`,\n        );\n      }\n      sessionManager = SessionManager.create(cwd, sessionDir);\n    }\n\n    const result = await createAgentSession({\n      cwd,\n      sessionManager,\n      settingsManager: Settings.init({ cwd, agentDir: getAgentDir() }),\n      // Loop sessions intentionally load extensions (no disableExtensionDiscovery),\n      // plus skills and project context via default discovery.\n      skills: noSkills ? [] : undefined,\n      promptTemplates: [],\n      // No `tools` allowlist: matches a normal omp session\'s tool set.\n      model: model as any,\n      thinkingLevel: thinkingLevel as any,\n      modelRegistry,\n      agentRegistry: new AgentRegistry(),\n    });',
      label: "runAgentSession body",
    },
  ],
  "src/executor.ts": [
    {
      from: 'import type {\n\tExtensionContext,\n\tModelRuntime,\n\tAgentSessionEvent,\n} from "@oh-my-pi/pi-coding-agent";',
      to: 'import type {\n\tExtensionContext,\n\tAgentSessionEvent,\n} from "@oh-my-pi/pi-coding-agent";',
      label: "ModelRuntime import removal",
    },
    {
      from: "(ctx.modelRegistry as any).runtime as ModelRuntime,",
      to: "ctx.modelRegistry,",
      all: true,
      label: "modelRegistry pass-through",
    },
    {
      from: "\t// Pi's built-in retry (via SettingsManager) handles transient HTTP errors\n\t// with exponential backoff WITHIN a single prompt. Ralpi adds two layers on",
      to: "\t// The agent's built-in retry handles transient HTTP errors with exponential\n\t// backoff WITHIN a single prompt. Ralpi adds two layers on",
      label: "retry comment",
    },
    {
      from: '\t\tcase "find":\n\t\t\treturn sanitizeLabel(`${a.path ?? "."} — ${a.glob ?? "*"}`);\n\t\tcase "ls":\n\t\t\treturn sanitizeLabel(truncateMiddle(String(a.path ?? "."), 60));',
      to: '\t\tcase "glob":\n\t\t\treturn sanitizeLabel(`${a.path ?? "."} — ${a.glob ?? "*"}`);',
      label: "tool labeler find/ls",
    },
  ],
  "src/task-manager-prompt.ts": [
    {
      from: 'import * as fs from "node:fs";\nimport * as path from "node:path";\nimport { stripFrontmatter } from "@oh-my-pi/pi-coding-agent";\n\nconst TEMPLATE_REL = path.join("prompts", "task-manager.md");',
      to: 'import * as fs from "node:fs";\nimport * as path from "node:path";\n\nconst TEMPLATE_REL = path.join("prompts", "task-manager.md");\n\n/**\n * Strip leading YAML frontmatter (--- delimited) from template content.\n * Local port of the helper omp does not export from the package root.\n */\nfunction stripFrontmatter(content: string): string {\n  const m = /^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/.exec(content);\n  return m ? content.slice(m[0].length) : content;\n}',
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
  const wfDir = join(dstDir, ".gitea", "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "publish.yml"), PORT_PUBLISH_WORKFLOW);

  console.log("== bun install (regenerates bun.lock + node_modules)");
  execSync("bun install", { cwd: dstDir, stdio: "inherit" });
  console.log("== done");
}

portExtension();
