# 04. Thread `ExtensionCommandContext` through `executeBatch`

meta:
  id: ralph-loop-fixes-04
  feature: ralph-loop-fixes
  priority: P1
  depends_on: []
  tags: [implementation, plumbing]

objective:
- Pass `ctx: ExtensionCommandContext` from command handlers through to all executor functions that need it, replacing the missing `piApi: ExtensionAPI` parameter

deliverables:
- Modified `index.ts` — all `executeBatch()` calls pass `ctx` as 6th parameter
- Modified `src/executor.ts` — `executeBatch()`, `executeTask()`, `runTask()`, `executeBatchParallel()` accept `ctx: ExtensionCommandContext`

steps:
- Open `src/executor.ts`
- Add `import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"`
- Update `executeBatch()` signature: add `ctx: ExtensionCommandContext` as 6th parameter (after `progress`)
- Update `executeTask()` signature: add `ctx: ExtensionCommandContext` parameter
- Update `runTask()` signature: add `ctx: ExtensionCommandContext` parameter
- Update `executeBatchParallel()` signature: add `ctx: ExtensionCommandContext` parameter
- Thread `ctx` through all internal calls (batch → task → run)
- Open `index.ts`
- In `handleRun()`: pass `ctx` to `executeBatch()`
- In `handleResume()`: pass `ctx` to `executeBatch()`
- In `handleNext()`: pass `ctx` to `executeBatch()`

tests:
- Manual: `/ralph run` should execute without "undefined is not a function" errors
- Manual: `/ralph resume` should execute without context-related errors

acceptance_criteria:
- `executeBatch()` receives a valid `ExtensionCommandContext` in all call paths
- No `undefined` access errors when executor calls `ctx.ui.*`
- TypeScript compiles without errors

validation:
- Run `npx tsc --noEmit` in extension directory
- Verify `ctx` parameter exists in all executor function signatures
- Verify all call sites in index.ts pass `ctx`

notes:
- `ExtensionCommandContext` extends `ExtensionContext` and adds session control methods
- Command handlers receive `ExtensionCommandContext`, not bare `ExtensionContext`
- The `piApi` parameter was `ExtensionAPI` which has `sendMessage()` — we're replacing it with `ctx` which has `ctx.ui` for UI access
