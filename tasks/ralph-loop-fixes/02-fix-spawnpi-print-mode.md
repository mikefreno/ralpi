# 02. Replace `spawnPi` with `--print` mode and stdin piping

meta:
  id: ralph-loop-fixes-02
  feature: ralph-loop-fixes
  priority: P1
  depends_on: []
  tags: [implementation, utils]

objective:
- Replace `spawnPi()` so it invokes `pi --print` with prompt content piped via stdin, instead of using non-existent `--no-stream` and `--prompt` flags

deliverables:
- Modified `src/utils.ts` — `spawnPi()` function
- Updated `src/executor.ts` — import and call site for `spawnPi`

steps:
- Open `src/utils.ts` and locate `spawnPi()`
- Replace `spawnSync` args from `["--no-stream", "--prompt", promptFile, ...]` to `["--print"]`
- Read the prompt file content and pass it as `input` to `spawnSync`
- The `input` option accepts a string that is piped to the child process stdin
- Keep `encoding`, `timeout`, and `maxBuffer` options as-is
- Update the function signature if needed (no longer needs `promptFile` path, can take prompt content directly, or read it internally)

tests:
- Manual: Spawn pi with a simple prompt — verify it returns text output and exits cleanly
- Manual: Verify `result.stdout` contains the pi response text (not NDJSON or event stream)

acceptance_criteria:
- `spawnPi()` exits with code 0 on successful execution
- `result.stdout` contains plain text response from pi
- No "Unknown options: --no-stream, --prompt" error

validation:
- Run `pi --print` with piped input manually to verify behavior
- Check spawnSync call uses `["--print"]` args and `input` option

notes:
- Pi's `--print` flag runs in non-interactive mode: reads from stdin, writes to stdout, exits
- `spawnSync` accepts an `input` option (string) that pipes to child stdin
- Current broken args: `["--no-stream", "--prompt", promptFile]`
- The `extractTextFromEvent()` function can be simplified or removed since `--print` returns plain text
