# Ralpi

Execute tasks from task files until done using DAG-based dependency resolution with persistent progress tracking.

## Features

- **Parallel batching**: Independent tasks in each batch can run concurrently
- **Persistent progress**: Execution state saved to `.ralpi/progress.json`
- **Reflection system**: Each task produces a reflection for downstream tasks
- **Retry with backoff**: Failed tasks retry with exponential backoff
- **Multiple formats**: Supports simple checkboxes, and YAML
- **Tool usage tracking**: Detects and reports tool usage (read, write, edit, bash) from task execution
- **Configurable timeouts**: Task-level timeouts via meta blocks, with global fallback
- **Session saving**: Saves full task output for expandable session review
- **Resume auto-discovery**: Automatically finds and resumes interrupted execution

## Usage

```
/ralpi [task-file]        # Execute all tasks
/ralpi plan               # Alias to /task-manager to plan new tasks
/ralpi resume             # Resume paused execution
/ralpi reset [task-file]  # Reset progress and .ralpi directory - does not modify PRD
```

## Task File Formats

### Highly recommended to use the task-manager prompt for prd construction, it's output pairs perfectly

# Project Title

## Tasks

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

## Dependencies

### Arrow Notation (recommended):

1 -> 2,3,4
5 -> 6
This means: "Task 1 must complete before tasks 2, 3, and 4 can start."

### Natural Language:

13 depends on 17, 18, 19, 20
14 depends on 13, 15, 16

This means: "Task 13 depends on tasks 17, 18, 19, and 20."

### Parallel Groups (informational only):

1, 2, 3, 4 can be done in parallel
5, 6, 7, 8 can be done in parallel

Note: These lines are ignored by the parser. Use explicit dependencies to control execution order.



## Configuration

### Task-Level Timeout

You can set a timeout for individual tasks using a meta block in the task file:

```markdown
- [ ] 01: Setup project structure
  timeout: 10m
```

Supported formats: `10m` (minutes), `600s` (seconds), `3600000` (milliseconds)


### Config files

| Scope | Path |
|-------|------|
| **Global** | `~/.pi/ralpi/config.yaml` |
| **Project** | `./.ralpi/config.yaml` |

```yaml
execution:
  maxParallel: 3          # ralpi-level concurrency only
  models:                 # round-robin in <provider>/<model> format
    - google/gemini-3.5-flash # 1st and 3rd task in parallel
    - openai/gpt-5.5 # 2nd task in parallel
prompts:
  projectContext: "Additional context for all tasks"
```

> `execution.models` uses slot-aware round-robin: with 3 models and 2 concurrent
> tasks, only the first two models are used. The third model is only touched when
> a third concurrent task starts. Freed model slots are reused before new ones
> are allocated.
>
> **Automatic failover**: if a provider/API is unreachable (rate limit, 503, etc.),
> the task automatically cycles to the next model in the list without counting it
> as a task failure. Each model is tried once before the task is marked as failed.

## State Files

- `.ralpi/progress.json` - Execution progress
- `.ralpi/reflections/` - Per-task reflections
- `.ralpi/prompts/` - Generated prompts
- `.ralpi/sessions/` - Full task output for review
