# 03. Replace `sendMessage` with `ctx.ui` progress API

meta:
  id: ralph-loop-fixes-03
  feature: ralph-loop-fixes
  priority: P1
  depends_on: [ralph-loop-fixes-04]
  tags: [implementation, executor]

objective:
- Replace all `piApi.sendMessage({ customType: "ralph-progress", display: true })` calls with `ctx.ui.notify()` and `ctx.ui.setStatus()` to avoid TUI crash from unregistered custom message renderer

deliverables:
- Modified `src/executor.ts` — remove `sendProgressMessage()`, replace with `ctx.ui` calls
- Modified `src/executor.ts` — remove `formatToolUsage()` if no longer needed, or keep for status text

steps:
- Open `src/executor.ts`
- Remove `sendProgressMessage()` function entirely
- In `runTask()`, replace `sendProgressMessage(piApi, task, project, "starting")` with `ctx.ui.setStatus("ralph", "Running ${task.id}: ${task.title}")`
- In `runTask()` success path, replace `sendProgressMessage(..., "completed")` with `ctx.ui.notify()` for completion summary
- In `runTask()` failure path, replace `sendProgressMessage(..., "failed")` with `ctx.ui.notify()` for error
- In `executeBatch()`, replace batch start `piApi.sendMessage()` with `ctx.ui.setStatus()`
- In `executeTask()`, replace retry `piApi.sendMessage()` with `ctx.ui.notify()`
- Remove `piApi: ExtensionAPI` parameter from all executor functions (replaced by `ctx: ExtensionCommandContext`)
- Remove unused `ExtensionAPI` import from executor.ts

tests:
- Manual: Run a task and verify progress appears in the Pi UI without crash
- Manual: Verify no `child.render is not a function` error

acceptance_criteria:
- No TUI crash during task execution
- Progress messages visible to user via `ctx.ui`
- `sendProgressMessage()` function removed from codebase
- `piApi.sendMessage()` no longer called anywhere in executor

validation:
- Grep for `sendMessage` in executor.ts — should only appear in comments or not at all
- Grep for `customType.*ralph-progress` — should be removed
- Verify `ctx.ui.notify` and `ctx.ui.setStatus` are used instead

notes:
- `ctx.ui.notify(message, type)` shows a notification — use "info" for progress, "error" for failures
- `ctx.ui.setStatus(key, text)` sets footer status text — good for "Running task X" updates
- `ctx.ui.setStatus(key, undefined)` clears the status
- The TUI crash (`child.render is not a function`) happens because `customType: "ralph-progress"` has no registered renderer via `pi.registerMessageRenderer()`
