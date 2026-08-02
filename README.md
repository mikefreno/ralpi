# Ralpi

Execute tasks from task files until done using DAG-based dependency resolution with persistent progress tracking.

```bash
pi install npm:@mikefreno/ralpi
```

## Features

- **DAG-based execution**: Tasks ordered via dependencies (arrow notation, natural language, "must be done before", or YAML)
- **Parallel batching**: Independent tasks in each batch run concurrently, round-robin across configured models
- **Persistent progress**: Execution state saved to `.ralpi/progress.json`, supporting multiple PRDs simultaneously
- **Resume & auto-resume**: `/ralpi-resume` continues paused execution; a session reload mid-loop auto-resumes via `.ralpi/loop-active.json`
- **Reflection system**: Each task produces a reflection for downstream tasks
- **Phased plans**: `## Phase N — Title` sections add implicit phase-boundary dependencies
- **Model failover**: Unreachable providers cycle to the next model in the list before a task fails
- **Auto-commit / auto-review loop**: Optional per-task commit and review-gated re-execution until pass
- **Worktree isolation**: Parallel tasks run in separate git worktrees so they can't stomp each other, with batch-level merge-conflict resolution
- **Multiple formats**: Fio README (numbered + dependencies), phased, simple checkboxes, and YAML
- **Tool usage tracking**: Reports read/write/edit/bash usage from task execution
- **Configurable timeouts**: Task-level timeouts (inline, meta block, or YAML) with global fallback

## Usage

```
/ralpi [task-file]         # No args → show plan for README.md; path arg → run tasks
/ralpi-run [task-file]     # Execute tasks from a task file
/ralpi-plan [prompt]       # Open the Task Manager to plan tasks
/ralpi-resume [task-file]  # Resume paused/interrupted execution
/ralpi-reset [task-file]   # Reset execution progress — does not modify the PRD
```

`/ralpi` with no arguments shows the execution plan for the default task file. When the first token looks like a path (`@path`, `./path`, `path/file.md`, `.yaml`, etc.) it routes to `/ralpi-run`. Everything else is handled by the dedicated dash commands above (the old `/ralpi plan|resume|reset` subcommand syntax is gone).

> The task-manager prompt (`/ralpi-plan`) pairs perfectly with ralpi's task file formats — use it for PRD construction.

## Tasks

### Simple Checkbox Format

```markdown
- [ ] Setup project structure
- [ ] Implement auth
- [ ] Build API
```

Checkbox-only files get sequential IDs (`01`, `02`, ...). Status characters: `[ ]` pending, `[x]` done, `[~]` in progress, `[!]` failed, `[-]` skipped.

### Fio Format (numbered tasks + dependencies)

```markdown
# Build a web application

## Tasks

- [ ] 01 — Setup project structure
- [ ] 02 — Implement auth
- [ ] 03 — Build API

## Dependencies

01 -> 02, 03
```

### YAML Format

```yaml
objective: Build a web application
tasks:
  - id: "01"
    title: Setup project structure
    file: tasks/01-setup.md
    dependencies: []
  - id: "02"
    title: Implement auth
    file: tasks/02-auth.md
    depends_on: ["01"]
```

## Task IDs

Task IDs are zero-padded 2-digit strings (`01`, `02`, ...) with an optional
single lowercase letter suffix for sub-tasks inserted between two numbered
steps (e.g. `02b`, `02c`). The parser normalizes `2b` → `02b`.

```
- [ ] 01 — Setup
- [ ] 02 — Fix bugs
- [ ] 02b — Sub-step of 02 (inserted after the fact)
- [ ] 02c — Another sub-step of 02
- [ ] 03 — Continue
```

Use lettered sub-tasks when you discover mid-stream that a step needs to be
split. They let you preserve sibling numbering (`01`, `02`, `03`, ...) while
adding granularity between two existing steps.

## Phases

`## Phase N — Title` headings group tasks into phases and add an implicit
dependency from the first task of each phase to the last task of the
previous one, so phases always run in order:

```markdown
## Phase 1 — Push-to-Talk MVP

- [ ] 01 — Voice capture
- [ ] 02 — Transmission

## Phase 2 — Group Chat

- [ ] 03 — Channels
- [ ] 04 — Presence
```

## Dependencies

Dependency lines live in a `## Dependencies` section (or a plain
`Dependencies` heading). Multiple formats are supported and can be mixed.

### Arrow Notation (recommended)

```
1 -> 2,3,4
5 -> 6
```

"Task 1 must complete before tasks 2, 3, and 4 can start." Also supports
chains (`03 -> 04 -> 05`) and multi-prereq sources (`05, 07, 08 -> 13`).

### Natural Language

```
13 depends on 17, 18, 19, 20
14 depends on 13, 15, 16
22, 23, 24 depend on 21
```

"Task 13 depends on tasks 17, 18, 19, and 20." `also depends on` is accepted.

### "must be done before"

```
21 must be done before 22, 23, 24
02, 03 must be done before 04
```

### Parallel Groups

```
1, 2, 3, 4 can be done in parallel (Play Store prep)
5, 6, 7, 8 can be done in parallel
```

Tasks listed in a parallel group are allowed to run concurrently. Group
declarations imply no cross-group dependencies, and intra-group
dependencies are still respected — group-aware batching produces a plan
where tasks from any group run as soon as their dependencies are
satisfied.

## Configuration

### Task-Level Timeout

Timeouts can be set inline on the task line, as an inline comment, via a
meta block in the Dependencies section, or in YAML:

```markdown
- [ ] 01 — Setup project structure timeout: 10m
- [ ] 02 — Implement auth # timeout=30s
```

```markdown
## Dependencies

01 -> 02
01 [timeout] = 10m
```

```yaml
tasks:
  - id: "01"
    title: Setup project structure
    timeout: 15m
```

Supported units: `m` / `min` (minutes), `s` (seconds), `ms` (milliseconds).
Bare numbers default to minutes; in YAML, numeric values ≥ 1000 are treated
as milliseconds.

### Config files

| Scope | Path |
|-------|------|
| **Global** | `~/.pi/ralpi/config.yaml` |
| **Project** | `./.ralpi/config.yaml` |

Project config overrides global, which overrides defaults. Keys set
explicitly in YAML skip the corresponding loop-startup prompt.

```yaml
execution:
  maxParallel: 3              # ralpi-level concurrency only (0 = unlimited)
  models:                     # round-robin for parallel tasks, <provider>/<model>
    - anthropic/claude-sonnet-4
    - openai/gpt-4o
  autoCommit: true            # commit after each task (mandated when autoReview is on)
  autoReview: false           # commit → review → loop on fail → merge on pass
  saveReviews: false          # persist full review output to .ralpi/reviews/ (only with autoReview)
  maxReviewRetries: 2         # re-executions on a 'fail' verdict before giving up
  reviewBlockOnFail: false    # true = mark task failed after retries exhausted instead of merging
  implModel: ""               # model for task impl (empty = inherit parent session model)
  commitModel: ""             # model for commit sessions (empty = inherit task model)
  reviewModel: ""             # model for review sessions (empty = inherit task model)
  timeoutMs: 0                # per-task timeout in ms (0 = inherit Pi's defaults)
  commitTimeoutMs: 0          # timeout for auto-commit agent sessions (0 = inherit)
  reviewTimeoutMs: 0          # timeout for auto-review agent sessions (0 = inherit)
  loopTimeoutMs: 0            # max total loop duration in ms (0 = no limit; checked between batches)
  worktrees: parallel         # "never" | "parallel" (default) | "always" — git worktree isolation
prompts:
  projectContext: "Additional context for all tasks"
  reflectionPrompt: ""        # custom suffix for reflection extraction
```

> `execution.models` uses slot-aware round-robin: with 3 models and 2 concurrent
> tasks, only the first two models are used. The third model is only touched when
> a third concurrent task starts. Freed model slots are reused before new ones
> are allocated.
> **Automatic failover**: if a provider/API is unreachable (rate limit, 503, etc.),
> the task automatically cycles to the next model in the list without counting it
> as a task failure. Each model is tried once before the task is marked as failed.
> **NOTE**: model lists are only used in parallel execution. In sequential mode
> (or parallel mode with no `models` list) the parent pi session's model is used,
> unless `implModel` is set.

#### Auto-review and Auto-commit

At loop startup the review question is asked FIRST. When `autoReview` is
enabled, commit is **mandated** — after task execution, changes are
committed (via a commit agent session when the task agent didn't
self-commit), then the complete task diff (`baseRef..HEAD`) is reviewed
against the task description. On a `fail` verdict the task is
re-executed with the review feedback injected into the prompt (looping
until the review passes or `maxReviewRetries` is exhausted). After
re-execution, changes are committed again and the full diff is
re-reviewed with the same base ref so the reviewer sees the complete
state — original work plus fixes. On pass, the changes are already
committed and the worktree merges.

When `autoReview` is disabled, `autoCommit` runs a follow-up commit
agent after each task with no review. With `autoReview` on, the user is
also asked whether to persist full review output to
`.ralpi/reviews/<prdKey>/<task-id>.json` (`saveReviews` — this is what
enables review feedback recovery when resuming interrupted loops). Both
options can be overridden at loop startup via a selection prompt (config
YAML values are honored without prompting when set explicitly).

`commitModel` and `reviewModel` accept `<provider>/<model>` strings (e.g.
`anthropic/claude-sonnet-4`) resolved via the model registry. When empty, the
task's model is inherited. `implModel` sets the model for task implementation
(used whenever no round-robin model is assigned — sequential mode, or parallel
mode with an empty `models` list; overridden by `execution.models` round-robin
in parallel mode).

## State Files

```
.ralpi/progress.json           # Execution progress (supports multiple PRDs)
.ralpi/loop-active.json        # Active-loop marker used for auto-resume after a reload
.ralpi/reflections/            # Per-task reflections
.ralpi/reviews/<prdKey>/       # Full review output (when saveReviews is on)
.ralpi/prompts/                # Generated prompts (timestamped, for debugging)
.ralpi/config.yaml             # Project-level config (optional)
```
