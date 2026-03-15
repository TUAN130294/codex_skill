# Think-About Workflow

## 1) Inputs
- User question/topic.
- Scope and constraints.
- Relevant files or external facts.
- Reasoning effort level.

## 1.5) Pre-flight Checks
1. Verify `codex` CLI is in PATH: `command -v codex`. If not found, tell user to install.
2. Verify working directory is writable (for state directory creation).

## 1.8) Prompt Assembly

1. Read the Round 1 template from `references/prompts.md`.
2. Replace `{QUESTION}` with user's question or topic.
3. Replace `{PROJECT_CONTEXT}` with project description (or "Not specified — infer from codebase").
4. Replace `{RELEVANT_FILES}` with file list (or "None specified").
5. Replace `{CONSTRAINTS}` with scope constraints (or "None specified").
6. Replace `{OUTPUT_FORMAT}` by copying the entire fenced code block from `references/output-format.md`.

## 2) Start Round 1

Set `ROUND=1`.

```bash
STATE_OUTPUT=$(printf '%s' "$PROMPT" | node "$RUNNER" start --working-dir "$PWD" --effort "$EFFORT" --sandbox danger-full-access)
STATE_DIR=${STATE_OUTPUT#CODEX_STARTED:}
```

**Do NOT poll yet.** Proceed immediately to Step 2.5.

## 2.5) Claude Independent Analysis (BEFORE polling)

**PURPOSE**: Form Claude's own position BEFORE seeing Codex's output. Prevents anchoring bias.

**INFORMATION BARRIER**: MUST NOT read `$STATE_DIR/review.md`. Codex đang chạy background — để nó làm việc trong khi bạn suy nghĩ.

**TIMING**: Giữa Start Codex (Step 2) và Poll (Step 3). Codex Round 1 thường mất 90-180s, Claude có đủ thời gian.

### Instructions

1. Read the Claude Independent Analysis Prompt from `references/prompts.md`.
2. Replace placeholders (same values as Round 1 prompt): `{QUESTION}`, `{PROJECT_CONTEXT}`, `{RELEVANT_FILES}`, `{CONSTRAINTS}`.
3. Replace `{CLAUDE_ANALYSIS_FORMAT}` by copying the entire fenced code block from `references/claude-analysis-template.md`.
4. Analyze using own knowledge. MAY use MCP tools (web_search, context7, ask_internet) for research — source parity with Codex's web access.
5. Write analysis in format from `references/claude-analysis-template.md`.
6. **CRITICAL**: Analysis must be COMPLETE and FINAL before proceeding to Step 3. Commit to specific positions.

### After Completing Analysis

Store analysis internally (needed for Step 4 cross-analysis). Proceed to Step 3 (Poll).

## 3) Poll

**BARRIER REMINDER**: Independent analysis đã hoàn tất ở Step 2.5. Khi polling, report Codex's *activities* nhưng KHÔNG interpret conclusions. Analysis đã locked.

```bash
POLL_OUTPUT=$(node "$RUNNER" poll "$STATE_DIR")
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

After each poll, parse the status lines and report **specific activities** to the user. NEVER say generic messages like "Codex is running" or "still waiting" — these provide no information.

**Poll output parsing guide:**

| Poll line pattern | Report to user |
|-------------------|---------------|
| `Codex thinking: "**topic**"` | Codex analyzing: {topic} |
| `Codex running: ... 'git diff ...'` | Codex reading repo diff |
| `Codex running: ... 'cat src/foo.ts'` | Codex reading file `src/foo.ts` |
| `Codex running: ... 'rg -n "pattern" ...'` | Codex searching for `pattern` in code |
| `Codex running: ... 'curl ...'` | Codex fetching web content |
| Multiple curl commands completed | Codex researched {N} web sources |
| Multiple completed commands | Codex read {N} files, analyzing results |
| `Codex changed: <path> (<kind>)` | **WARNING: Codex modified file `<path>`** — see Step 4.5 |
| `Codex running: ... 'wget ...'` | **WARNING: wget detected** — may write files, monitor Step 4.5 |

**Report template:** "Codex [{elapsed}s]: {specific activity summary}" — always include elapsed time and concrete description.

Continue while status is `running`.
Stop on `completed|failed|timeout|stalled`.

**On `POLL:completed`:**
1. Extract thread ID from poll output: look for `THREAD_ID:<id>` line.
2. Read Codex output: `cat "$STATE_DIR/review.md"`.
3. Save for Round 2+: `THREAD_ID=<extracted id>`.

## 4) Cross-Analysis (Claude's Independent View vs Codex's Output)

After `POLL:completed`:

### 4a) Read Codex Output
1. Read from `$STATE_DIR/review.md`.
2. Parse Key Insights, Considerations, Recommendations, Sources, Open Questions, Confidence Level, Suggested Status.

### 4b) Compare Positions (Side-by-Side)

Classify mỗi topic/insight:

| Classification | Meaning | Handle |
|---------------|---------|--------|
| **Genuine Agreement** | Cả hai independently đi đến cùng kết luận | Strong consensus signal |
| **Genuine Disagreement** | Có opposing positions từ trước | Real debate point — defend with evidence |
| **Claude-only Insight** | Claude thấy mà Codex không | Present as new perspective |
| **Codex-only Insight** | Codex tìm được mà Claude không | Evaluate on merits — accept hoặc challenge |
| **Same Direction, Different Depth** | Cả hai thấy issue nhưng one went deeper | Synthesize deeper analysis |

### 4c) Build Response

1. **Agreements**: Points cả hai independently converged. Strong signals vì không ai influence ai.
2. **Disagreements**: Genuine disagreements. State Claude's independent position + why Codex's position doesn't change it (hoặc does — be honest).
3. **New Perspectives**: Claude-only insights + evaluate Codex-only insights on merits.
4. **Source Cross-validation**: Compare sources. Flag claims lacking citations.
5. Set status: `CONTINUE`, `CONSENSUS`, or `STALEMATE`. Consider Codex's Suggested Status but override if evidence warrants a different assessment.

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
# Create a temp dir for baseline BEFORE starting the round (STATE_DIR doesn't exist yet)
FS_GUARD_DIR=$(mktemp -d)

# Snapshot: list all files with mtime (portable across macOS and Linux)
# Parentheses ensure the || fallback output is always piped to sort
( find . -not -path './.codex-review/*' -type f -exec stat -f '%m %N' {} + 2>/dev/null \
  || find . -not -path './.codex-review/*' -type f -exec stat -c '%Y %n' {} + 2>/dev/null ) \
  | sort > "$FS_GUARD_DIR/fs-baseline.txt"
```

After starting the round (STATE_DIR now exists), copy baseline for reference:
```bash
cp "$FS_GUARD_DIR/fs-baseline.txt" "$STATE_DIR/fs-baseline.txt"
```

After round completes:
```bash
( find . -not -path './.codex-review/*' -type f -exec stat -f '%m %N' {} + 2>/dev/null \
  || find . -not -path './.codex-review/*' -type f -exec stat -c '%Y %n' {} + 2>/dev/null ) \
  | sort > "$STATE_DIR/fs-after.txt"
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

**Note**: Từ Round 2 trở đi, information barrier không còn áp dụng — cả hai đã thấy positions của nhau. Debate tiếp tục bình thường.

Build Round 2+ prompt from `references/prompts.md` (Response Prompt template):
- Replace `{AGREED_POINTS}` with Claude's agreements from step 4.
- Replace `{DISAGREED_POINTS}` with Claude's rebuttals from step 4.
- Replace `{NEW_PERSPECTIVES}` with new angles from step 4.
- Replace `{CONTINUE_OR_CONSENSUS_OR_STALEMATE}` with status from step 4.
- Replace `{OUTPUT_FORMAT}` by copying the entire fenced code block from `references/output-format.md`.

**Note:** Sandbox mode (`danger-full-access`) persists automatically via `codex exec resume --thread-id`. Do NOT pass `--sandbox` on resume — it is inherited from the original thread.

```bash
STATE_OUTPUT=$(printf '%s' "$RESPONSE_PROMPT" | node "$RUNNER" start \
  --working-dir "$PWD" --thread-id "$THREAD_ID" --effort "$EFFORT")
STATE_DIR=${STATE_OUTPUT#CODEX_STARTED:}
```

**→ Go back to step 3 (Poll).** Increment `ROUND` counter. After poll completes, repeat step 4 and check stop conditions. If `ROUND >= 5`, force final synthesis — do NOT resume. Otherwise, continue until a stop condition is reached.

## 6) Stop Conditions
- Consensus reached.
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

## 8) Cleanup
```bash
node "$RUNNER" stop "$STATE_DIR"
```
Remove the state directory and kill any remaining Codex/watchdog processes. Always run this step, even if the debate ended due to failure or timeout.

## Error Handling

Runner `poll` returns status via output string `POLL:<status>:<elapsed>[:exit_code:details]`. Normally exits 0, but may exit non-zero when state dir is invalid or I/O error — handle both cases:

**Parse POLL string (exit 0):**
- `POLL:completed:...` → Success, read review.md from state dir.
- `POLL:failed:...:3:...` → Turn failed. Retry once. If still fails, report error.
- `POLL:timeout:...:2:...` → Timeout. Report partial results if review.md exists. Suggest retry with lower effort.
- `POLL:stalled:...:4:...` → Stalled. Report partial results. Suggest lower effort.

**Fallback when poll exits non-zero or output cannot be parsed:**
- Log error output, report infrastructure error to user, suggest retry.

Runner `start` may fail with exit code:
- 1 → Generic error (invalid args, I/O). Report error message.
- 5 → Codex CLI not found. Tell user to install.

Always run cleanup (step 8) regardless of error.

## Stalemate Handling

When stalemate detected (repeated claims with no new evidence for two rounds):
1. List specific deadlocked points.
2. Show each side's final argument for each point.
3. Recommend which perspective user should favor.
4. If `ROUND < 5`, ask user: accept current synthesis or force one more round. If `ROUND >= 5` (hard cap), force final synthesis — do NOT offer another round.
