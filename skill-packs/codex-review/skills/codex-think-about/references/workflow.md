# Think-About Workflow

## 1) Inputs
- User question/topic.
- Scope and constraints.
- Relevant files or external facts.
- Reasoning effort level.

## 2) Start Round 1
```bash
STATE_OUTPUT=$(printf '%s' "$PROMPT" | "$RUNNER" start --working-dir "$PWD" --effort "$EFFORT")
STATE_DIR=${STATE_OUTPUT#CODEX_STARTED:}
```

## 3) Poll
- Poll every 15 seconds.
- Continue while `POLL:running`.
- Stop on `completed`, `failed`, `timeout`, or `stalled`.

## 4) Claude Response
After Codex output:
- List agreements.
- List disagreements and why.
- Add missing angles.
- Set status (`CONTINUE`, `CONSENSUS`, `STALEMATE`).

## 5) Resume Round 2+
```bash
STATE_OUTPUT=$(printf '%s' "$RESPONSE_PROMPT" | "$RUNNER" start \
  --working-dir "$PWD" --thread-id "$THREAD_ID" --effort "$EFFORT")
```

## 6) Stop Conditions
- Consensus reached.
- Stalemate detected (repeated claims with no new evidence for two rounds).
- Hard cap reached.

## 7) Final User Output
- Key insights.
- Recommendations.
- Remaining disagreements.
- Confidence level.
