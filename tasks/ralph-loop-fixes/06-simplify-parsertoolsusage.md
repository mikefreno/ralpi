# 06. Simplify `parseToolUsage` for plain text output

meta:
  id: ralph-loop-fixes-06
  feature: ralph-loop-fixes
  priority: P2
  depends_on: [ralph-loop-fixes-02]
  tags: [implementation, utils]

objective:
- Remove NDJSON event parsing from `parseToolUsage()` since `pi --print` returns plain text, not structured event streams

deliverables:
- Modified `src/utils.ts` — `parseToolUsage()` function

steps:
- Open `src/utils.ts` and locate `parseToolUsage()`
- Remove the NDJSON parsing block (lines that check `line.startsWith("data: ")` and `JSON.parse`)
- Keep only the regex fallback that counts tool mentions in plain text output
- Remove `extractTextFromEvent()` if no longer needed (plain text from `--print` needs no extraction)
- Update `executor.ts` to call `parseToolUsage()` directly on `result.stdout` without `extractTextFromEvent()`

tests:
- Manual: Run a task that uses multiple tools — verify tool counts are captured from plain text output
- Manual: Verify no JSON parse errors in tool usage parsing

acceptance_criteria:
- `parseToolUsage()` works correctly on plain text output
- No JSON parsing logic remains in `parseToolUsage()`
- Tool counts ([read], [write], [edit], [bash]) are still extracted via regex

validation:
- Grep for `JSON.parse` in parseToolUsage — should be removed
- Grep for `data:` prefix check — should be removed
- Verify regex-based tool counting still present and functional

notes:
- `pi --print` returns plain text, not NDJSON event stream
- The regex fallback patterns (`\[read\]`, `read(`, etc.) are sufficient for counting tool mentions
- `extractTextFromEvent()` was only needed for NDJSON — can be removed or simplified to identity function
