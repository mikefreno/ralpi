# ralph-loop

Execute tasks from task files using DAG-based dependency resolution with persistent progress tracking.

## Features

- **DAG-based execution**: Tasks are ordered by dependencies using Kahn's algorithm
- **Parallel batching**: Independent tasks in each batch can run concurrently
- **Persistent progress**: Execution state saved to `.ralph/progress.json`
- **Reflection system**: Each task produces a reflection for downstream tasks
- **Retry with backoff**: Failed tasks retry with exponential backoff
- **Multiple formats**: Supports Fio README, simple checkboxes, and YAML

## Usage

```
/ralph plan [task-file]   # Show execution plan
/ralph run [task-file]    # Execute all tasks
/ralph status [task-file] # Show current progress
/ralph resume [task-file] # Resume paused execution
/ralph next [task-file]   # Execute next batch only
/ralph reset [task-file]  # Reset all progress
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

1 -> 2
2 -> 3
```

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

Create `.ralph/config.yaml`:

```yaml
maxRetries: 3
retryDelayMs: 5000
timeoutMs: 1800000
maxParallel: 3
projectContext: "Additional context for all tasks"
```

## State Files

- `.ralph/progress.json` - Execution progress
- `.ralph/reflections/` - Per-task reflections
- `.ralph/prompts/` - Generated prompts
