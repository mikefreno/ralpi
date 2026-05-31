# Ralpi

Execute tasks from task files using DAG-based dependency resolution with persistent progress tracking.

## Features

- **DAG-based execution**: Tasks are ordered by dependencies using Kahn's algorithm
- **Parallel batching**: Independent tasks in each batch can run concurrently
- **Persistent progress**: Execution state saved to `.ralpi/progress.json`
- **Reflection system**: Each task produces a reflection for downstream tasks
- **Retry with backoff**: Failed tasks retry with exponential backoff
- **Multiple formats**: Supports Fio README, simple checkboxes, and YAML
- **Chat progress**: Real-time progress messages in Pi chat via `pi.sendMessage`
- **Tool usage tracking**: Detects and reports tool usage (read, write, edit, bash) from task execution
- **Git commit capture**: Captures git commit messages and generates summaries per task
- **Configurable timeouts**: Task-level timeouts via meta blocks, with global fallback
- **Session saving**: Saves full task output for expandable session review
- **Resume auto-discovery**: Automatically finds and resumes interrupted execution
- **Custom message renderer**: Compact UI labels with expandable details in Pi TUI

## Usage

```
/ralpi plan [task-file]   # Show execution plan
/ralpi run [task-file]    # Execute all tasks
/ralpi status [task-file] # Show current progress
/ralpi resume [task-file] # Resume paused execution
/ralpi next [task-file]   # Execute next batch only
/ralpi reset [task-file]  # Reset all progress
```

## Task File Formats

### Fio README Format

```markdown
# Project Title

## Tasks

- [ ] 01 — Setup project structure -> `tasks/01-setup.md`
- [ ] 02 — Implement auth -> `tasks/02-auth.md`
- [ ] 03 — Build API -> `tasks/03-api.md`

## Dependencies

1 -> 2,3
2 -> 3
```

#### Supported Dependency Formats

The parser supports two dependency declaration styles in the `## Dependencies` section:

**Arrow Notation** (recommended):
```
1 -> 2,3,4
5 -> 6
```
This means: "Task 1 must complete before tasks 2, 3, and 4 can start."

**Natural Language**:
```
13 depends on 17, 18, 19, 20
14 depends on 13, 15, 16
```
This means: "Task 13 depends on tasks 17, 18, 19, and 20."

**Parallel Groups** (informational only):
```
1, 2, 3, 4 can be done in parallel
5, 6, 7, 8 can be done in parallel
```
Note: These lines are ignored by the parser. Use explicit dependencies to control execution order.

### Simple Checkbox Format

```markdown
- [ ] 01: Setup project structure
- [ ] 02: Implement auth
- [ ] 03: Build API
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

## Configuration

Create config files. Both are optional:

| Scope | Path |
|-------|------|
| **Global** | `~/.pi/ralpi/config.yaml` |
| **Project** | `./.ralpi/config.yaml` |

```yaml
execution:
  maxParallel: 3          # ralpi-level concurrency only
prompts:
  projectContext: "Additional context for all tasks"
```

> ralpi deliberately does **not** set timeouts or retries — those are inherited
> from Pi's own settings. Tasks run until they complete or Pi's own flow stops them.

The keys mirror the nested structure of `RalpiConfig` in `src/types.ts`.

### Precedence (highest wins)

| Priority | Source |
|----------|--------|
| **1st** | In-memory overrides (`model`, `thinkingLevel` from parent Pi session) |
| **2nd** | `./.ralpi/config.yaml` — project-level |
| **3rd** | `~/.pi/ralpi/config.yaml` — global, shared across projects |
| **4th** | `DEFAULT_CONFIG` in `src/types.ts` |

### Task-Level Timeout

You can set a timeout for individual tasks using a meta block in the task file:

```markdown
- [ ] 01: Setup project structure
  timeout: 10m
```

Supported formats: `10m` (minutes), `600s` (seconds), `3600000` (milliseconds)

## State Files

- `.ralpi/progress.json` - Execution progress
- `.ralpi/reflections/` - Per-task reflections
- `.ralpi/prompts/` - Generated prompts
- `.ralpi/sessions/` - Full task output for review
