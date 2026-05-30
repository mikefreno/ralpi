# 05. Fix sequential mode batch labels

meta:
  id: ralph-loop-fixes-05
  feature: ralph-loop-fixes
  priority: P2
  depends_on: [ralph-loop-fixes-04]
  tags: [implementation, ui]

objective:
- Suppress "Batch N:" label for single-task batches; use numbered list format (1., 2., 3.) for sequential task execution to match original behavior

deliverables:
- Modified `src/executor.ts` — `executeBatch()` console output

steps:
- Open `src/executor.ts` and locate `executeBatch()`
- In the batch header log, check if `tasks.length === 1`
- If single task: log `[ralph] Running task ${task.id}: ${task.title}` (no "Batch N" wrapper)
- If multiple tasks: keep existing `=== Batch N (M tasks) ===` format
- Track global task counter for sequential numbered output if needed

tests:
- Manual: Run a single-task batch — verify no "Batch N" in output
- Manual: Run a multi-task batch — verify "Batch N" still appears

acceptance_criteria:
- Single-task batches do not show "Batch N:" prefix
- Multi-task batches still show batch header
- Output format matches original: `[ralph] Running task 001: Title`

validation:
- Check `console.log` output in executeBatch for conditional formatting
- Verify single-task path uses task-focused label

notes:
- Original behavior: single tasks show numbered list (1., 2., 3.), batches show "Batch N:"
- Current code always shows `[ralph] === Batch N (M tasks) ===` regardless of batch size
- This is cosmetic but matches user preference for compact UI
