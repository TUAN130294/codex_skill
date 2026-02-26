# Implementation Review Workflow

## 1) Collect Inputs
- Working directory path.
- User request and acceptance criteria.
- Uncommitted changes.
- Optional plan file for intent alignment.

## 2) Start Round 1
```bash
STATE_OUTPUT=$(printf '%s' "$PROMPT" | "$RUNNER" start --working-dir "$PWD" --effort "$EFFORT")
STATE_DIR=${STATE_OUTPUT#CODEX_STARTED:}
```

## 3) Poll
- Use `"$RUNNER" poll "$STATE_DIR"` every 15 seconds.
- Continue while status is `running`.
- Stop on `completed|failed|timeout|stalled`.

## 4) Apply/Rebut
- Parse `ISSUE-{N}` blocks.
- For valid issues: edit code and record fix evidence.
- For invalid issues: write rebuttal with concrete proof (paths, tests, behavior).

## 5) Resume Thread
```bash
STATE_OUTPUT=$(printf '%s' "$REBUTTAL_PROMPT" | "$RUNNER" start \
  --working-dir "$PWD" --thread-id "$THREAD_ID" --effort "$EFFORT")
```

## 6) Completion Criteria
- Codex returns `VERDICT: APPROVE`.
- Or user accepts a documented stalemate.

## 7) Final Output
- Round count and verdict.
- Fixed defects by severity.
- Disputed items and rationale.
- Residual risk (if any).
