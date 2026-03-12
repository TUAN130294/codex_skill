# Auto Review Workflow

## Step 1: Collect Inputs

Ask user for:
- **Scope**: `working-tree` (default), `branch`, `full`
- **Effort**: `low`, `medium`, `high` (default), `xhigh`
- **Mode**: `parallel` (default), `sequential`

If branch scope, ask for base branch name (default: auto-detect main/master).

## Step 2: Detection

Run the detection engine:

```bash
DETECT_OUTPUT=$(node "$RUNNER" detect --working-dir "$PWD" --scope "$SCOPE")
```

### Parsing Detection Output

The `detect` command outputs JSON to stdout:

```json
{
  "skills": ["codex-impl-review", "codex-security-review"],
  "scores": {
    "codex-impl-review": {
      "score": 100,
      "confidence": "high",
      "reasons": ["has uncommitted code changes"],
      "signals": [
        { "type": "git_state", "weight": 100, "reason": "has uncommitted code changes", "matched": "uncommitted changes" }
      ]
    },
    "codex-security-review": {
      "score": 85,
      "confidence": "high",
      "reasons": ["SQL queries found in 3 files", "auth patterns detected"],
      "signals": [...]
    }
  },
  "scope": "working-tree",
  "files_analyzed": 12,
  "threshold": 50,
  "git_available": true
}
```

### Exit Code Handling

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | Parse JSON, proceed |
| 1 | Error (bad args, dir not found) | Report error, abort |
| 6 | Git not available | Warn user, proceed with partial results (file-scan only) |

### Display to User

Show a table of detected skills:

```
Detected skills for review:
  codex-impl-review      [100] high   - has uncommitted code changes
  codex-security-review  [ 85] high   - SQL queries found, auth patterns detected
  codex-commit-review    [  0] --     - (below threshold, skipped)
```

## Step 3: Confirm

- Show final list of skills that will run
- User can add/remove skills (e.g., "also run plan-review" or "skip security-review")
- If `codex-codebase-review` was detected, display: "Large codebase detected (N files) -- run `/codex-codebase-review` directly for full chunked analysis."
- If no skills detected, display: "No skills matched threshold (50). Try `--threshold 30` for broader detection, or run a specific skill directly."
- User confirms to proceed

## Step 4: Execute

### Parallel Mode (Default)

1. For each selected skill, read its prompt template:
   ```
   ~/.claude/skills/<skill-name>/references/prompts.md
   ```
2. Fill template variables:
   - `{{WORKING_DIR}}` -> `$PWD`
   - `{{DIFF}}` -> output of `git diff` or `git diff <base>...HEAD`
   - `{{FILE_LIST}}` -> changed files list
   - `{{PLAN_PATH}}` -> path to plan file (if plan-review)
3. Start up to 3 Codex processes simultaneously:
   ```bash
   node "$RUNNER" start --working-dir "$PWD" --effort "$EFFORT"
   ```
4. Poll all running processes in round-robin with adaptive intervals:
   - First poll: 60s wait
   - Second poll: 60s wait
   - Third poll: 30s wait
   - Subsequent: 15s intervals
5. After each poll, report specific activities from poll output
6. When a process completes, read its `review.md` from the state directory

### Sequential Mode (`--sequential`)

1. Sort selected skills by detection score (highest first)
2. Run skills one at a time
3. After each skill completes, append a brief summary of its key findings to the next skill's prompt as additional context
4. This allows later skills to build on earlier findings

### Failure Handling

- If a Codex process fails (timeout/stall/error): continue other jobs, note failure
- If >50% of parallel jobs fail: warn user, suggest `--sequential` mode
- Never fail silently -- always report which skills succeeded and which failed

### Cleanup

Always run cleanup for each started process:
```bash
node "$RUNNER" stop "$STATE_DIR"
```

## Step 5: Merge & Report

### Session Directory

Create a session directory for the merged report:
```
.codex-review/auto-runs/<unix-timestamp>-<pid>/
  review.md           <- merged markdown report
  meta.json           <- session metadata
  sub-reviews/
    codex-impl-review/    <- copy of sub-skill review.md
    codex-security-review/
```

### Merge Process (LLM-based)

Claude Code reads all `review.md` files and:

1. **Collect**: Parse all `ISSUE-{N}` blocks from all skill outputs
2. **Deduplicate**: Identify findings about the same issue (same file + similar problem). Keep the more detailed version. Tag duplicates.
3. **Sort**: Order by severity: critical > high > medium > low
4. **Tag**: Label each finding with source skill: `[security]`, `[impl]`, `[commit]`, `[pr]`, `[plan]`
5. **Unified Verdict**:
   - Any skill says REVISE -> overall REVISE
   - All skills APPROVE -> overall APPROVE
   - Mixed with stalemate -> note stalemate items
6. **Write** unified report to `review.md` in session directory
7. **Write** `meta.json` with session metadata:
   ```json
   {
     "skills_run": ["codex-impl-review", "codex-security-review"],
     "detection_scores": { ... },
     "execution_mode": "parallel",
     "timing": { "total_seconds": 120, "per_skill": { ... } },
     "verdicts": { "codex-impl-review": "REVISE", "codex-security-review": "APPROVE" },
     "overall_verdict": "REVISE"
   }
   ```

### Present Results

- Display the unified report to the user
- Show path to session directory for reference
- If overall verdict is REVISE, ask user if they want to fix issues
- If overall verdict is APPROVE, congratulate and suggest next steps
