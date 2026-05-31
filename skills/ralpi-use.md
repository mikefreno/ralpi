---
description: Executes individual tasks from ralpi task files using DAG-based dependency resolution, with progress tracking and reflection support
---

# ralpi-task

Execute a single task from a ralpi task file.

## When to Use

- User asks to execute a specific task from a task file
- User provides a task ID and wants to run it
- User wants to run the next task in sequence

## Usage

```
/ralpi run [task-file]      # Run all tasks
/ralpi next [task-file]     # Run next batch
/ralpi status [task-file]   # Check progress
```

## Task File Location

Default: `README.md` in current directory. Can be overridden with explicit path.

## Reflection Format

After completing a task, include:

```
## REFLECTION
SUMMARY: [what was done]
FILES: [files changed]
LEARNINGS:
- [key learning]
BLOCKERS: [issues or 'none']
```
