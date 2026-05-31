# AGENTS.md

## What this is

A Pi coding agent extension that registers the `/ralpi` slash command. Not a standalone app — it runs inside Pi's extension host.

## Type checking

```
npm run typecheck    # tsc --noEmit
```

No build step needed — Pi loads extensions via [jiti](https://github.com/unjs/jiti), which compiles TypeScript at runtime. `index.ts` is the entry point directly.

## Entry point

`index.ts` at repo root (not `src/`). Exports a default function receiving `ExtensionAPI`.

## External dependencies

The extension imports from Pi SDK packages (not in `package.json` — provided by the host):
- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`, `createAgentSession`, etc.
- `@earendil-works/pi-tui` — `Box`, `Text` for custom message renderer

The only real npm dependency is `yaml` (^2.4.0).

## Source structure

- `index.ts` — extension entry, command routing, UI registration, reload detection
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
  - `constants.ts` — static constants
- `skills/ralpi-use.md` — Pi skill definition for task execution
- `prompts/task-manager.md` — Pi prompt for task planning

## Runtime state

All runtime state lives in `.ralpi/` in the **project directory** (not this extension directory):
- `.ralpi/progress.json` — execution progress, supports multiple PRDs
- `.ralpi/reflections/` — per-task reflection JSON files
- `.ralpi/prompts/` — generated prompts (timestamped, for debugging)
- `.ralpi/sessions/` — full session transcripts

## Task ID convention

Task IDs are zero-padded strings (`"01"`, `"02"`, etc.). The parser prepends `0` to parsed digits. Never use raw numeric IDs.

## Command routing

`/ralpi` with no args → plan. First token looks like a path (`@path`, `./path`, `.md`, etc.) → run. Otherwise dispatches to subcommand (`run`, `plan`, `resume`, `reset`).

## Config

Read from `.ralpi/config.yaml` in project directory. Falls back to `DEFAULT_CONFIG` in `src/types.ts` when file is missing. Config is loaded at `projectDir` level, not extension level.
