# Ralph-Loop Extension Fixes

Objective: Fix critical bugs preventing `/ralph resume` from working — broken CLI flags, unthreaded context, missing config, and TUI crash.

Status legend: [ ] todo, [~] in-progress, [x] done

Tasks
- [x] 01 — Fix `loadConfig` to return defaults gracefully when `.ralph/config.yaml` is missing → `01-fix-loadconfig-graceful-default.md`
- [x] 02 — Replace `spawnPi` with `--print` mode and stdin piping → `02-fix-spawnpi-print-mode.md`
- [x] 03 — Replace `sendMessage` with `ctx.ui` progress API → `03-replace-sendmessage-with-ctx-ui.md`
- [x] 04 — Thread `ExtensionCommandContext` through `executeBatch` → `04-thread-ctx-through-execute-batch.md`
- [x] 05 — Fix sequential mode batch labels → `05-fix-sequential-mode-labels.md`
- [x] 06 — Simplify `parseToolUsage` for plain text output → `06-simplify-parsertoolsusage.md`

Dependencies
- 02 depends on nothing (standalone utils fix)
- 03 depends on 04 (needs ctx available in executor)
- 04 depends on nothing (standalone plumbing fix)
- 05 depends on 04 (executor changes)
- 06 depends on 02 (output format changes from --print)

Exit criteria
- `/ralph resume` runs without errors in a project with no `.ralph/config.yaml`
- Pi subprocess spawns successfully with `--print` mode
- Progress messages display via `ctx.ui` without TUI crash
- All batch execution paths receive context parameter
