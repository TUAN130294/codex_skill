# Think-About Workflow

## 1) Inputs
- User question/topic (may be vague — SKILL.md step 1 runs question-sharpening before this workflow begins).
- Question sharpening output: confirmed `{QUESTION}` from SKILL.md step 1 (sharpened or original if sharpening was skipped).
- Reasoning effort level.
- Scope and constraints.
- Relevant files or external facts.

## 2) Start Round 1

### 2a) Initialize Session

```bash
INIT_OUTPUT=$(node "$RUNNER" init --skill-name codex-think-about --working-dir "$PWD")
SESSION_DIR=${INIT_OUTPUT#CODEX_SESSION:}
```

**Validate init output:** Verify `INIT_OUTPUT` starts with `CODEX_SESSION:`. If not, report error.

### 2b) Render Prompt

Compute `SKILLS_DIR` from the runner path — it is the grandparent directory of the runner script (e.g., `~/.claude/skills`):

```bash
SKILLS_DIR="$(dirname "$(dirname "$RUNNER")")"
```

```bash
PROMPT=$(echo '{"QUESTION":"...","PROJECT_CONTEXT":"...","RELEVANT_FILES":"...","CONSTRAINTS":"..."}' | \
  node "$RUNNER" render --skill codex-think-about --template round1 --skills-dir "$SKILLS_DIR")
```

`{QUESTION}` is the confirmed sharpened question from SKILL.md step 1 (or the original question if sharpening was skipped).

`{OUTPUT_FORMAT}` is auto-injected by the render command from `references/output-format.md`.

### 2c) Start Codex

```bash
echo "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --effort "$EFFORT" --sandbox danger-full-access
```

**Validate start output (JSON):**
```json
{ "status": "started", "session_dir": "/path", "round": 1 }
```
If `status` is `"error"`, report to user.

**Do NOT poll yet.** Proceed immediately to Step 2.5.

## 2.5) Claude Independent Analysis (BEFORE polling)

**PURPOSE**: Form Claude's own position BEFORE seeing Codex's output. Prevents anchoring bias.

**INFORMATION BARRIER**: MUST NOT read Codex output from poll JSON `review` field. Codex is running in background — let it work while you think.

**TIMING**: Between Start Codex (Step 2) and Poll (Step 3). Codex Round 1 typically takes 90-180s, Claude has enough time.

### Instructions

1. Render Claude analysis prompt:
```bash
CLAUDE_PROMPT=$(echo '{"QUESTION":"...","PROJECT_CONTEXT":"...","RELEVANT_FILES":"...","CONSTRAINTS":"..."}' | \
  node "$RUNNER" render --skill codex-think-about --template claude-analysis --skills-dir "$SKILLS_DIR")
```
`{CLAUDE_ANALYSIS_FORMAT}` is auto-injected by the render command from `references/claude-analysis-template.md`.

2. Analyze using own knowledge. MAY use MCP tools (web_search, context7, ask_internet) for research — source parity with Codex's web access.
3. Write analysis following the rendered format.
4. **CRITICAL**: Analysis must be COMPLETE and FINAL before proceeding to Step 3. Commit to specific positions.

### After Completing Analysis

Store analysis internally (needed for Step 4 cross-analysis). Proceed to Step 3 (Poll).

## 3) Poll

**BARRIER REMINDER**: Independent analysis is complete from Step 2.5. When polling, report Codex's *activities* but do NOT interpret conclusions. Analysis is locked.

```bash
POLL_JSON=$(node "$RUNNER" poll "$SESSION_DIR")
```

Adaptive intervals — start slow, speed up (longer than other skills due to web requests):

**Round 1 (first review — includes web research):**
- Poll 1: wait 90s
- Poll 2: wait 60s
- Poll 3: wait 30s
- Poll 4+: wait 15s

**Round 2+ (rebuttal rounds):**
- Poll 1: wait 45s
- Poll 2: wait 30s
- Poll 3+: wait 15s

**Parse JSON output:**

Running:
```json
{
  "status": "running",
  "round": 1,
  "elapsed_seconds": 45,
  "activities": [
    { "time": 30, "type": "thinking", "detail": "researching WebSocket vs SSE tradeoffs" },
    { "time": 35, "type": "command_started", "detail": "curl -sS https://docs.example.com" }
  ]
}
```

Report **specific activities** from the `activities` array. Example: `"Codex [90s]: researching WebSocket vs SSE tradeoffs, reading docs"`. NEVER say generic messages like "Codex is running" or "still waiting" — always extract concrete details from activities.

**WARNING notes:**
- `type: "file_changed"` in activities → **WARNING: Codex modified file** — see Step 4.5
- `wget` detected in activities → **WARNING: wget detected** — may write files, monitor Step 4.5

Continue while `status` is `"running"`.
Stop on `"completed"|"failed"|"timeout"|"stalled"`.

**Completed:**
```json
{
  "status": "completed",
  "round": 1,
  "elapsed_seconds": 120,
  "thread_id": "thread_abc",
  "review": {
    "format": "think-about",
    "insights": [
      { "text": "WebSocket provides true bidirectional...", "source": "https://..." }
    ],
    "considerations": [
      { "text": "SSE has better browser reconnection...", "source": "analysis" }
    ],
    "recommendations": [
      "Use WebSocket for real-time collaborative features"
    ],
    "sources": [
      { "num": 1, "url": "https://...", "description": "Official docs for X" }
    ],
    "open_questions": ["..."],
    "confidence": "medium",
    "suggested_status": "CONTINUE",
    "raw_markdown": "..."
  },
  "activities": [...]
}
```

**Failed/Timeout/Stalled:**
```json
{
  "status": "failed|timeout|stalled",
  "round": 1,
  "elapsed_seconds": 3600,
  "exit_code": 2,
  "error": "Timeout after 3600s",
  "review": null,
  "activities": [...]
}
```

## 4) Cross-Analysis (Claude's Independent View vs Codex's Output)

After poll returns `"completed"`:

### 4a) Read Codex Output
Parse from poll JSON `review` field:
- `review.insights` — array of insights with text and source
- `review.considerations` — array of considerations
- `review.recommendations` — array of recommendations
- `review.sources` — array of sources with URLs
- `review.open_questions` — array of open questions
- `review.confidence` — confidence level
- `review.suggested_status` — CONTINUE/CONSENSUS/STALEMATE
- `review.raw_markdown` — always available as fallback

### 4b) Compare Positions (Side-by-Side)

Classify each topic/insight:

| Classification | Meaning | Handle |
|---------------|---------|--------|
| **Genuine Agreement** | Both independently reached same conclusion | Strong consensus signal |
| **Genuine Disagreement** | Have opposing positions from the start | Real debate point — defend with evidence |
| **Claude-only Insight** | Claude found but Codex did not | Present as new perspective |
| **Codex-only Insight** | Codex found but Claude did not | Evaluate on merits — accept or challenge |
| **Same Direction, Different Depth** | Both found issue but one went deeper | Synthesize deeper analysis |

### 4c) Build Response

1. **Agreements**: Points both independently converged. Strong signals since neither influenced the other.
2. **Disagreements**: Genuine disagreements. State Claude's independent position + why Codex's position doesn't change it (or does — be honest).
3. **New Perspectives**: Claude-only insights + evaluate Codex-only insights on merits.
4. **Source Cross-validation**: Compare sources. Flag claims lacking citations.
5. Set status: `CONTINUE`, `CONSENSUS`, or `STALEMATE`. Consider Codex's `review.suggested_status` but override if evidence warrants a different assessment.

> **Note:** Round tracking is automatic. The runner manages `rounds.json` — do NOT read or write it manually.

## 4.5) File Modification Guard

After each round completes, check if Codex modified any project files. `danger-full-access` sandbox is for web research ONLY — file writes are forbidden by prompt but not enforced by sandbox.

**IMPORTANT: Capture a baseline BEFORE each round starts.** The guard compares post-round state against this baseline, not against a clean working tree. This avoids false positives when the repo already has uncommitted changes.

**In a git repo:**

Before starting each round:
```bash
BASELINE=$(git status --porcelain --untracked-files=all --ignored 2>/dev/null)
```

After round completes:
```bash
CURRENT=$(git status --porcelain --untracked-files=all --ignored 2>/dev/null)
```

Compare `BASELINE` vs `CURRENT`. If there are NEW lines in `CURRENT` that were not in `BASELINE`, Codex modified files. Use `--ignored` flag to also detect writes to gitignored paths (e.g. `dist/`, `coverage/`, `.env.*`).

**Outside a git repo (fallback):**

Before starting each round, create a baseline snapshot using a portable method. Since `find -printf` is GNU-only (not available on macOS/BSD), use a cross-platform approach:

```bash
# Create a temp dir for baseline BEFORE starting the round (SESSION_DIR doesn't exist yet)
FS_GUARD_DIR=$(mktemp -d)

# Snapshot: list all files with mtime (portable across macOS and Linux)
# Parentheses ensure the || fallback output is always piped to sort
( find . -not -path './.codex-review/*' -type f -exec stat -f '%m %N' {} + 2>/dev/null \
  || find . -not -path './.codex-review/*' -type f -exec stat -c '%Y %n' {} + 2>/dev/null ) \
  | sort > "$FS_GUARD_DIR/fs-baseline.txt"
```

After starting the round (SESSION_DIR now exists), copy baseline for reference:
```bash
cp "$FS_GUARD_DIR/fs-baseline.txt" "$SESSION_DIR/fs-baseline.txt"
```

After round completes:
```bash
( find . -not -path './.codex-review/*' -type f -exec stat -f '%m %N' {} + 2>/dev/null \
  || find . -not -path './.codex-review/*' -type f -exec stat -c '%Y %n' {} + 2>/dev/null ) \
  | sort > "$SESSION_DIR/fs-after.txt"
```

Compare by extracting paths and classifying changes:
- Files in `fs-after.txt` but not in `fs-baseline.txt` (by path) → **added**
- Files in `fs-baseline.txt` but not in `fs-after.txt` (by path) → **deleted**
- Files in both but with different mtime → **modified**

Use `comm` or `awk` on the path column (field 2) to classify. Do NOT interpret raw `diff` `<`/`>` markers directly — a modified file appears as both `<` and `>` with different mtimes.

Clean up: `rm -rf "$FS_GUARD_DIR"` after round.

**If file changes detected:**
1. **STOP the workflow immediately.** Do NOT continue to the next round.
2. List every file that was modified, created, or deleted.
3. Warn the user: "Codex violated file modification rules. The following files were changed: [list]"
4. **Do NOT automatically revert.** Let the user decide how to handle the changes.
5. Run cleanup (Step 8) to stop the Codex process.

## 5) Resume Round 2+

**Note**: From Round 2 onward, the information barrier no longer applies — both sides have seen each other's positions. Debate continues normally.

### 5a) Render Round 2+ Prompt

```bash
PROMPT=$(echo '{"AGREED_POINTS":"...","DISAGREED_POINTS":"...","NEW_PERSPECTIVES":"...","CONTINUE_OR_CONSENSUS_OR_STALEMATE":"..."}' | \
  node "$RUNNER" render --skill codex-think-about --template round2+ --skills-dir "$SKILLS_DIR")
```

`{OUTPUT_FORMAT}` is auto-injected by the render command from `references/output-format.md`.

**Note:** Sandbox mode (`danger-full-access`) persists automatically via the Codex thread. Do NOT pass `--sandbox` on resume — it is inherited from the original thread.

### 5b) Resume Codex

```bash
echo "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --effort "$EFFORT"
```

**Validate resume output (JSON):**
```json
{ "status": "started", "session_dir": "/path", "round": 2, "thread_id": "thread_abc" }
```

Then **go back to step 3 (Poll).** After poll completes, repeat step 4 (Cross-Analysis) and check completion criteria below. If not met, resume again (step 5). Continue this loop until a completion criterion is reached.

## 6) Stop Conditions
- Consensus reached (`review.suggested_status === "CONSENSUS"`).
- Stalemate detected (repeated claims with no new evidence for two rounds).
- Hard cap reached (5 rounds maximum).

## 7) Final User Output

**Note:** Per-round Codex output follows the schema in `references/output-format.md`. This final synthesis is Claude's user-facing summary of the debate result.

### Consensus Points
- {agreed points}

### Remaining Disagreements
| Point | Claude | Codex |
|-------|--------|-------|
| ... | ... | ... |

### Recommendations
- {actionable recommendations}

### Consolidated Sources
| # | URL | Description | Used By |
|---|-----|-------------|---------|
| 1 | https://... | ... | Codex |
| 2 | https://... | ... | Claude |
| 3 | https://... | ... | Both |

### Open Questions
- {unresolved questions}

### Confidence Level
- low | medium | high

## 8) Session Finalization

After the final synthesis is complete, finalize the session:

```bash
echo '{"verdict":"CONSENSUS","scope":"think-about"}' | node "$RUNNER" finalize "$SESSION_DIR"
```

Optionally include debate tracking:
```bash
echo '{"verdict":"CONSENSUS","scope":"think-about","insights":{"total_agreed":5,"total_disagreed":2,"total_open":1}}' | \
  node "$RUNNER" finalize "$SESSION_DIR"
```

The runner auto-computes `meta.json` with timing, round count, and session metadata.

Report `$SESSION_DIR` path to the user in the final summary.

## 9) Cleanup
```bash
node "$RUNNER" stop "$SESSION_DIR"
```
Always run this step, even if the debate ended due to failure or timeout.

## Error Handling

### Poll Errors
Poll returns JSON. Parse `status` field:
- `"completed"` → success, review data in `review` field.
- `"failed"` (exit_code 3) → turn failed. Retry once. If still failing, report error to user.
- `"timeout"` (exit_code 2) → timeout. Report partial results from `review.raw_markdown` if available. Suggest retry with lower effort.
- `"stalled"` (exit_code 4) → stalled. Report partial results. Suggest lower effort.
- `"error"` → infrastructure error. Report `error` field to user.

### Start/Resume Errors
Start and resume return JSON. If `status` is `"error"`:
- Check `code` field: `"CODEX_NOT_FOUND"` → tell user to install codex. Other codes → report `error` message.

### General Rules
- Always run cleanup (step 9) regardless of error.
- Use `review.raw_markdown` as fallback if structured parsing misses edge cases.

## Stalemate Handling

When stalemate detected (repeated claims with no new evidence for two rounds):
1. List specific deadlocked points.
2. Show each side's final argument for each point.
3. Recommend which perspective user should favor.
4. If current round < 5, ask user: accept current synthesis or force one more round. If current round >= 5 (hard cap), force final synthesis — do NOT offer another round.
