# AGENTS.md

## What this is

A Pi coding agent extension that registers the `/ralpi` slash commands
(`/ralpi`, `/ralpi-run`, `/ralpi-plan`, `/ralpi-resume`, `/ralpi-reset`).
Not a standalone app — it runs inside Pi's extension host.

## Type checking

```
npm run typecheck    # tsc --noEmit
```

Tests: `bun test` (parser and DAG suites in `tests/`).

No build step needed — Pi loads extensions via [jiti](https://github.com/unjs/jiti), which compiles TypeScript at runtime. `index.ts` is the entry point directly.

## Entry point

`index.ts` at repo root (not `src/`). Exports a default function receiving `ExtensionAPI`.

## External dependencies

The extension imports from Pi SDK packages (not in `package.json` — provided by the host):

- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`, `createAgentSession`, etc.
- `@earendil-works/pi-tui` — `Box`, `Text` for custom message renderer

The only real npm dependency is `yaml` (^2.4.0). It is used for parsing YAML
task files (`src/parser.ts`) and config files (`parseSimpleYaml` in
`src/utils.ts`, which falls back to a flat key:value parser when the package
is unavailable).

## Source structure

- `index.ts` — extension entry, command registration (`ralpi`, `ralpi-run`,
  `ralpi-plan`, `ralpi-resume`, `ralpi-reset`), execution-mode + loop-option
  prompts, reload auto-resume via `session_start`, progress message renderer
- `src/` — all logic modules:
  - `parser.ts` — task file parsing (Fio/README numbered, phased, checkbox,
    YAML formats), dependency + parallel-group + timeout parsing,
    `updateTaskInFile()` for PRD checkbox updates
  - `dag.ts` — Kahn's algorithm dependency resolution, group-aware batching,
    cycle detection, sequential/parallel plan builders
  - `executor.ts` — task execution, parallel/sequential modes, model
    round-robin + failover, review-gated loop, worktree orchestration,
    batch-level conflict resolution
  - `review.ts` — review verdict extraction (`## REVIEW VERDICT`), review
    save/load to `.ralpi/reviews/`
  - `worktree.ts` — git worktree create/merge/cleanup helpers, stale-worktree
    cleanup, `finalizeCommittedWorktrees()`
  - `progress.ts` — `.ralpi/progress.json` state management (multi-PRD)
  - `prompts.ts` — prompt generation for spawned agent sessions
  - `reflection.ts` — reflection extraction from agent output
  - `utils.ts` — config loading, progress/PRD discovery, `runAgentSession()`,
    model resolution (`resolveModelSpec`), loop-active marker
  - `types.ts` — all interfaces and `DEFAULT_CONFIG`
  - `widget-batcher.ts` — debounced widget updates for parallel tasks
  - `task-manager-prompt.ts` — loads and expands the bundled
    `prompts/task-manager.md` template for `/ralpi-plan`
  - `constants.ts` — static constants (slash command, task file names,
    reflection/review patterns)
- `tests/` — bun test suites for parser and DAG behavior
- `skills/ralpi-use.md` — Pi skill definition for task execution
- `prompts/task-manager.md` — Pi prompt for task planning

## Runtime state

All runtime state lives in `.ralpi/` in the **project directory** (not this extension directory):

- `.ralpi/progress.json` — execution progress, supports multiple PRDs
- `.ralpi/loop-active.json` — marker written while a loop runs; drives
  auto-resume after a session reload
- `.ralpi/reflections/` — per-task reflection JSON files
- `.ralpi/reviews/<prdKey>/` — full review output JSON (only when
  `saveReviews` is on)
- `.ralpi/prompts/` — generated prompts (timestamped, for debugging)
- `.ralpi/config.yaml` — project-level config (optional)

There is no `.ralpi/sessions/` directory anymore — full task output is shown
inline via expandable `ralpi-progress` chat messages, and review output is
persisted under `.ralpi/reviews/`.

## Task ID convention

Task IDs are zero-padded strings (`"01"`, `"02"`, etc.) with an optional
single lowercase letter suffix for sub-tasks (`"02b"`, `"02c"`). The parser
normalizes `2b` → `02b` (see `normalizeTaskId` in `src/parser.ts`). Never
use raw numeric IDs.

## Command routing

- `/ralpi` — no args → show plan for `README.md`; first token looks like a
  path (`@path`, `./path`, `.md`, `.yaml`, etc.) → run; anything else →
  error suggesting the dash commands
- `/ralpi-run [task-file]` — run tasks (auto-resumes when progress already
  exists for the file; otherwise prompts for execution mode + loop options)
- `/ralpi-plan [prompt]` — loads the bundled `prompts/task-manager.md`
  template and sends it as a user message. Pi's `sendUserMessage()` sends
  with `expandPromptTemplates: false`, so the extension does its own
  frontmatter stripping and `$@`/`$1` arg substitution
  (`loadTaskManagerPrompt` in `src/task-manager-prompt.ts`)
- `/ralpi-resume [task-file]` — resume from persisted progress; prompts for
  the PRD when multiple loops have progress. Reuses the loop snapshot in
  `loop-active.json` (mode + autoCommit/autoReview/saveReviews) to resume
  non-interactively
- `/ralpi-reset [task-file]` — reset execution progress (does not modify the PRD)

The old `/ralpi plan|resume|reset` subcommand dispatch, plus `status` and
`next`, were removed.

## Config

Read from `.ralpi/config.yaml` in project directory (and global
`~/.pi/ralpi/config.yaml`), project overrides global. Falls back to
`DEFAULT_CONFIG` in `src/types.ts` when files are missing. Config is loaded
at `projectDir` level, not extension level. Execution keys explicitly
present in a loaded YAML are tracked in `execution.explicitKeys` so the
loop-startup interactive prompts (`selectLoopOptions` in `index.ts`) can be
skipped for fields the user already set.

Key config fields in `execution`:

- `autoCommit` / `autoReview` / `saveReviews` — loop options (selectable at
  loop startup via `selectLoopOptions`; review is asked FIRST, commit is
  mandated when review is on)
- `models` — slot-aware round-robin model list for parallel mode, with
  failover to the next model per task (only after exhausting same-model
  retries, see `maxSameModelAttempts`)
- `maxSameModelAttempts` — max attempts on the SAME model before cycling to
  the next model on failure (default 5, matching pi's normal retry count).
  Applies to task execution, commit/review follow-up sessions, and
  review-fix re-execution alike
- `implModel` / `commitModel` / `reviewModel` — `<provider>/<model>` strings
  resolved via `resolveModelSpec` in `utils.ts`
- `prompts.reviewFocus` — per-review custom focus/instructions, injected as a
  `## Custom Review Focus` section in review prompts
- `review.extraIgnorePatterns` — extra noise-filter exclusion regexes (file
  paths) merged into the default rules
- `review.ignorePaths` — pathspec allowlist keeping matching files in review
  scope even when a default noise rule would exclude them
- `maxReviewRetries` / `reviewBlockOnFail` — review-gated loop retry behavior
- `worktrees` — `"never" | "parallel" | "always"` git worktree isolation
  (default `"parallel"`; see `shouldUseWorktrees` in `src/executor.ts`)
- `commitTimeoutMs` / `reviewTimeoutMs` — timeouts for follow-up sessions
- `loopTimeoutMs` — max total loop duration in ms (0 = no limit; checked
  between batches in `executePlanBatches`)
- `timeoutMs` — per-task execution timeout
- `prompts.projectContext` / `prompts.reflectionPrompt` — prompt-level settings
