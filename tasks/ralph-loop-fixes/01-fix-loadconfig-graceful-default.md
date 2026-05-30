# 01. Fix `loadConfig` to return defaults gracefully when `.ralph/config.yaml` is missing

meta:
  id: ralph-loop-fixes-01
  feature: ralph-loop-fixes
  priority: P1
  depends_on: []
  tags: [implementation, utils]

objective:
- `loadConfig()` should return `DEFAULT_CONFIG` silently when `.ralph/config.yaml` does not exist, without logging a warning to stderr

deliverables:
- Modified `src/utils.ts` — `loadConfig()` function

steps:
- Open `src/utils.ts` and locate `loadConfig()`
- Add `fs.existsSync()` check before `fs.readFileSync()`
- If config file does not exist, return a deep copy of `DEFAULT_CONFIG` without any console output
- If config file exists but is malformed, fall back to defaults silently
- Remove or suppress the `console.warn()` call

tests:
- Manual: Run `/ralph resume` in a project directory with no `.ralph/` directory — should not print warning
- Manual: Run `/ralph run` in a project with `.ralph/progress.json` but no `config.yaml` — should proceed with defaults

acceptance_criteria:
- No console warning when config.yaml is missing
- `loadConfig()` returns a valid `RalphConfig` object in all cases
- Existing behavior with valid config.yaml is unchanged

validation:
- Check `src/utils.ts` loadConfig function returns silently on missing file
- Verify no `console.warn` or `console.error` in the missing-config path

notes:
- Current code at line ~145 in utils.ts: `fs.readFileSync(configPath, "utf-8")` throws ENOENT
- The try-catch does catch it but still logs the warning — the warning is noisy for normal usage where config is optional
