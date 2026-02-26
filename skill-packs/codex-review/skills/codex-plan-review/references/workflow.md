# Plan Review Workflow

## 1) Gather Inputs
- Plan file path.
- User request text.
- Session context and constraints.
- Debate effort (`low|medium|high|xhigh`).

## 2) Start Round 1
```bash
STATE_OUTPUT=$(printf '%s' "$PROMPT" | "$RUNNER" start --working-dir "$PWD" --effort "$EFFORT")
STATE_DIR=${STATE_OUTPUT#CODEX_STARTED:}
```

## 3) Poll Loop
```bash
while true; do
  POLL_OUTPUT=$("$RUNNER" poll "$STATE_DIR")
  STATUS=$(printf '%s\n' "$POLL_OUTPUT" | head -1 | cut -d: -f2)
  if [ "$STATUS" = "running" ]; then
    sleep 15
    continue
  fi
  break
done
```

Terminal statuses: `completed`, `failed`, `timeout`, `stalled`.

## 4) Parse Review
- Read `THREAD_ID:` and `review.txt` from runner output/state directory.
- Extract `ISSUE-{N}` blocks.
- Apply accepted fixes to plan.
- Build rebuttal packet for disputed items.

## 5) Resume (Round 2+)
```bash
STATE_OUTPUT=$(printf '%s' "$REBUTTAL_PROMPT" | "$RUNNER" start \
  --working-dir "$PWD" --thread-id "$THREAD_ID" --effort "$EFFORT")
```

## 6) Stop Conditions
- `VERDICT: APPROVE`.
- Stalemate (same unresolved points for two consecutive rounds).
- User stops debate.

## 7) Final Report
- Round count.
- Final verdict.
- Accepted issues and plan edits.
- Disputed issues with reasoning.
- Final plan path.
