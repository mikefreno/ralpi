# AGENTS.md

## What this is

A Pi coding agent extension that registers the `/ralpi` slash command. Not a standalone app — it runs inside Pi's extension host.

## Build

```
npm run build    # tsc → dist/
npm run watch    # tsc --watch
```

No bundler, no linter, no test framework. Plain `tsc` with strict mode.

## Entry point

`index.ts` at repo root (not `src/`). Exports a default function receiving `ExtensionAPI`. The `tsconfig.json` sets `rootDir: "./"` so `index.ts` compiles to `dist/index.js`.

## External dependencies

The extension imports from Pi SDK packages (not in `package.json` — provided by the host):
- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`, `createAgentSession`, etc.
- `@earendil-works/pi-tui` — `Box`, `Text` for custom message renderer

The only real npm dependency is `yaml` (^2.4.0).

## Source structure

- `index.ts` — extension entry, command routing, UI registration
- `src/` — all logic modules:
  - `parser.ts` — task file parsing (Fio, checkbox, YAML formats)
  - `dag.ts` — Kahn's algorithm dependency resolution, batch planning
  - `executor.ts` — task execution, retry, parallel/sequential modes
  - `progress.ts` — `.ralpi/progress.json` state management
  - `prompts.ts` — prompt generation for spawned agent sessions
  - `reflection.ts` — reflection extraction from agent output
  - `utils.ts` — config loading, progress discovery, `runAgentSession()`
  - `types.ts` — all interfaces and `DEFAULT_CONFIG`
  - `widget-batcher.ts` — debounced widget updates for parallel tasks
- `skills/ralpi-use.md` — Pi skill definition for task execution
- `tasks/` — example ralpi task files (self-modification history)

## Runtime state

All runtime state lives in `.ralpi/` (gitignored):
- `.ralpi/progress.json` — execution progress, supports multiple PRDs
- `.ralpi/reflections/` — per-task reflection JSON files
- `.ralpi/prompts/` — generated prompts (timestamped, for debugging)
- `.ralpi/sessions/` — full session transcripts

## Task ID convention

Task IDs are zero-padded strings (`"01"`, `"02"`, etc.). The parser prepends `0` to parsed digits. Never use raw numeric IDs.

## Command routing

`/ralpi` with no args → plan. First token looks like a path (`@path`, `./path`, `.md`, etc.) → run. Otherwise dispatches to subcommand (`run`, `plan`, `status`, `resume`, `next`, `reset`).

## Config

Read from `.ralpi/config.yaml` in project directory. Falls back to `DEFAULT_CONFIG` in `src/types.ts` when file is missing. Config is loaded at `projectDir` level, not extension level.
