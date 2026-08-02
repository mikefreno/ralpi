---
description: Execute tasks from ralpi task files / PRDs using DAG-based dependency resolution, with persistent progress tracking and reflection support
---

# ralpi-task

Execute tasks from a ralpi task file (checkbox, Fio, phased, or YAML) using DAG-based dependency resolution, with persistent progress tracking and reflection support.

## When to Use

- User asks to execute a task file, PRD, or task list (e.g. "run the tasks", "execute the plan")
- User wants to run a full ralpi loop from a task file in the project
- User wants to resume an interrupted or paused ralpi run
- User wants to plan new tasks with the task-manager prompt

## Usage

```
/ralpi [task-file]        # No args → show plan; path arg → run all tasks
/ralpi-run [task-file]    # Run all tasks (auto-resumes if progress exists)
/ralpi-resume [task-file] # Resume paused/interrupted execution
/ralpi-plan [prompt]      # Open the Task Manager to plan tasks
```

Note: ralpi runs whole task plans — there is no single-task or next-batch subcommand. To execute only part of a plan, edit the task file and remove/adjust the tasks first.

## Task File Location

Default: `README.md` in the current directory. Can be overridden with an explicit path (`@path`, `./path`, `*.md`, `*.yaml`, `*.yml`).

## Reflection Format

After completing a task, the task agent ends its response with a reflection block, which the extension parses and passes to downstream tasks:

```
## REFLECTION
SUMMARY: [1-2 sentence description of what was accomplished]
FILES: [comma-separated list of files created or modified]
LEARNINGS:
- [key decision, pattern, or architectural choice]
- [important API or interface details]
- [anything downstream tasks need to know]
BLOCKERS: [any unresolved issues, or 'none']
```
