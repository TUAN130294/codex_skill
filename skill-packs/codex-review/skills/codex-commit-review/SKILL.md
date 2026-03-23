---
name: codex-commit-review
description: Peer debate between Claude Code and Codex on committed code quality. Report + suggest only, no modifications made.
---

# Codex Commit Review

## Purpose
Use this skill to debate committed code quality after committing and before pushing. Claude and Codex are equal analytical peers — Claude orchestrates the debate loop and final synthesis. No code is modified — report + suggest only.

## When to Use
After committing code (before push). Two modes: staged (review staged changes as pre-commit code preview) and last (review already-committed code changes).

## Prerequisites
- **Staged mode**: staged changes available (`git diff --cached`).
- **Last mode**: recent commits exist (`git log -n N`). Repository has commit history.

## Runner

```bash
RUNNER="{{RUNNER_PATH}}"
SKILLS_DIR="{{SKILLS_DIR}}"
json_esc() { printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(d)))'; }
```

## Stdin Format Rules
- **JSON** → `render`/`finalize`: heredoc. Literal-only → `<<'RENDER_EOF'`. Dynamic vars → escape with `json_esc`, use `<<RENDER_EOF` (unquoted).
- **json_esc output includes quotes** → embed directly: `{"KEY":$(json_esc "$VAL")}`.
- **Plain text** → `start`/`resume`: `printf '%s' "$PROMPT" | node "$RUNNER" ...` — NEVER `echo`.
- **NEVER** `echo '{...}'` for JSON. Forbidden: NULL bytes (`\x00`).

## Workflow

### 1. Collect Inputs
Auto-detect context and announce defaults before asking anything.

**Mode detection**: `git diff --cached --quiet 2>/dev/null` → exit 1 = `staged` (staged changes), exit 0 = `last`, other = ask user.

**Effort auto-detect**: Count diff lines. ≤200 lines → `low`, 201-1000 → `medium`, >1000 → `high`. Announce default.

Announce: `"Detected: mode=$MODE, effort=$EFFORT. Proceeding — reply to override."`

**Staged inputs**: staged changes (`git diff --cached`), files changed (`git diff --cached --name-only`).
**Last inputs**: `git log -n "$N" --format='%H%n%B---'` for commit info. Clamp N to history (`MAX=$(git rev-list --count HEAD)`; N > MAX → N=MAX; MAX=0 → abort). Diff: `git diff HEAD~"$N"..HEAD` when N < MAX; entire history: `EMPTY_TREE=$(git hash-object -t tree /dev/null) && git diff "$EMPTY_TREE"..HEAD`. Files: `git diff HEAD~"$N"..HEAD --name-only`.

### 2. Pre-flight Checks
Verify git repo (`git rev-parse --show-toplevel`). **Staged**: `git diff --cached --quiet` must FAIL (exit 1) — else abort "no staged changes". **Last**: validate N positive int, `git rev-list --count HEAD` > 0, clamp N, warn if diff empty.

### 3. Context Discovery
Discover project context (priority order, collect all that apply): 1) **User instruction** (explicit). 2) **Language/framework**: detect from file extensions, `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, etc. 3) **Linters/formatters**: `.eslintrc*`, `.prettierrc*`, `golangci-lint`, `ruff.toml`, `clippy`, etc. 4) **Test frameworks**: detect from `jest.config.*`, `vitest.config.*`, `pytest.ini`, `_test.go` files, etc. 5) **CI config**: `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`. 6) **Fallback**: Use general best practices for detected language. Store as `PROJECT_CONTEXT`.

### 4. Init Session
```bash
INIT_OUTPUT=$(node "$RUNNER" init --skill-name codex-commit-review --working-dir "$PWD")
SESSION_DIR=${INIT_OUTPUT#CODEX_SESSION:}
```
Validate: `INIT_OUTPUT` must start with `CODEX_SESSION:`.

### 5. Render Codex Prompt

**Staged mode** (template `staged-round1`):
```bash
PROMPT=$(node "$RUNNER" render --skill codex-commit-review --template staged-round1 --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"FILES_CHANGED":$(json_esc "$FILES_CHANGED"),"DIFF_CONTEXT":$(json_esc "$DIFF_CONTEXT"),"USER_REQUEST":$(json_esc "$USER_REQUEST"),"SESSION_CONTEXT":$(json_esc "$SESSION_CONTEXT"),"PROJECT_CONTEXT":$(json_esc "$PROJECT_CONTEXT")}
RENDER_EOF
)
```

**Last mode** (template `last-round1` — add `COMMIT_LIST`):
```bash
PROMPT=$(node "$RUNNER" render --skill codex-commit-review --template last-round1 --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"FILES_CHANGED":$(json_esc "$FILES_CHANGED"),"DIFF_CONTEXT":$(json_esc "$DIFF_CONTEXT"),"COMMIT_LIST":$(json_esc "$COMMIT_LIST"),"USER_REQUEST":$(json_esc "$USER_REQUEST"),"SESSION_CONTEXT":$(json_esc "$SESSION_CONTEXT"),"PROJECT_CONTEXT":$(json_esc "$PROJECT_CONTEXT")}
RENDER_EOF
)
```

### 6. Start Round 1
```bash
printf '%s' "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --effort "$EFFORT"
```
Validate JSON: `{"status":"started","round":1}`. Error with `CODEX_NOT_FOUND` → tell user to install codex. **Do NOT poll yet — proceed to Step 7.**

### 7. Claude Independent Analysis

**INFORMATION BARRIER**: MUST NOT read any Codex output until analysis is complete.

**Staged** (template `claude-staged`):
```bash
CLAUDE_PROMPT=$(node "$RUNNER" render --skill codex-commit-review --template claude-staged --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"FILES_CHANGED":$(json_esc "$FILES_CHANGED"),"DIFF_CONTEXT":$(json_esc "$DIFF_CONTEXT"),"PROJECT_CONTEXT":$(json_esc "$PROJECT_CONTEXT")}
RENDER_EOF
)
```

**Last** (template `claude-last` — add `COMMIT_LIST`):
```bash
CLAUDE_PROMPT=$(node "$RUNNER" render --skill codex-commit-review --template claude-last --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"FILES_CHANGED":$(json_esc "$FILES_CHANGED"),"DIFF_CONTEXT":$(json_esc "$DIFF_CONTEXT"),"COMMIT_LIST":$(json_esc "$COMMIT_LIST"),"PROJECT_CONTEXT":$(json_esc "$PROJECT_CONTEXT")}
RENDER_EOF
)
```

Read rendered prompt → read diff/code (staged: `git diff --cached`; last: `git show <SHA>` per commit + aggregate diff) → write FINDING-{N} per `references/claude-analysis-template.md` (last: Evidence MUST reference SHA+subject) → Overall Assessment (Code quality, Security posture, Test coverage impression, Maintainability) → Strongest Positions. **CRITICAL**: Complete BEFORE Step 8.

### 8. Poll
```bash
POLL_JSON=$(node "$RUNNER" poll "$SESSION_DIR")
```
**Poll intervals**: Round 1: 60s, 60s, 30s, 15s+. Round 2+: 30s, 15s+.

Report **specific activities** from `activities` array (e.g. "Codex [45s]: reading git diff --cached, analyzing code changes"). NEVER report generic "Codex is running".

Continue while `status === "running"`. Stop on `completed|failed|timeout|stalled`.

### 9. Cross-Analysis
Parse `review.blocks` (each: `id`, `title`, `severity`, `category`, `location`, `problem`, `evidence`) and `review.overall_assessment` from poll JSON. Verdict in `review.verdict.status`. Fallback: `review.raw_markdown`.

**Compare** Claude FINDING-{N} vs Codex ISSUE-{N}:

| Classification | Meaning |
|---------------|---------|
| Agreement | Both independently found same issue |
| Disagreement | Opposing assessment |
| Claude-only | Claude found, Codex did not |
| Codex-only | Codex found, Claude did not |
| Same Direction, Different Severity | Both found, disagree on severity |

**Build response**: 1) Agreements — merged findings. 2) Disagreements — Claude's position + evaluation of Codex's. 3) New findings — Claude-only + evaluation of Codex-only. 4) Set status: CONTINUE/CONSENSUS/STALEMATE. **Claude orchestration is authoritative** — Codex VERDICT is advisory.

### 10. Render Rebuttal + Resume

**Staged** (template `staged-round2+`):
```bash
PROMPT=$(node "$RUNNER" render --skill codex-commit-review --template staged-round2+ --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"SESSION_CONTEXT":$(json_esc "$SESSION_CONTEXT"),"PROJECT_CONTEXT":$(json_esc "$PROJECT_CONTEXT"),"AGREED_POINTS":$(json_esc "$AGREED_POINTS"),"DISAGREED_POINTS":$(json_esc "$DISAGREED_POINTS"),"NEW_FINDINGS":$(json_esc "$NEW_FINDINGS"),"CONTINUE_OR_CONSENSUS_OR_STALEMATE":$(json_esc "$STATUS"),"DIFF_CONTEXT":$(json_esc "$DIFF_CONTEXT")}
RENDER_EOF
)
```

**Last** (template `last-round2+` — add `COMMIT_LIST`):
```bash
PROMPT=$(node "$RUNNER" render --skill codex-commit-review --template last-round2+ --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"SESSION_CONTEXT":$(json_esc "$SESSION_CONTEXT"),"PROJECT_CONTEXT":$(json_esc "$PROJECT_CONTEXT"),"AGREED_POINTS":$(json_esc "$AGREED_POINTS"),"DISAGREED_POINTS":$(json_esc "$DISAGREED_POINTS"),"NEW_FINDINGS":$(json_esc "$NEW_FINDINGS"),"CONTINUE_OR_CONSENSUS_OR_STALEMATE":$(json_esc "$STATUS"),"DIFF_CONTEXT":$(json_esc "$DIFF_CONTEXT"),"COMMIT_LIST":$(json_esc "$COMMIT_LIST")}
RENDER_EOF
)
```

Resume: `printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --effort "$EFFORT"` → validate JSON. **Go back to step 8 (Poll).** Repeat 8→9→10 until CONSENSUS, STALEMATE, or 5 rounds.

### 11. Completion + Stalemate

**Consensus definitions**: Full (no disagreements), Partial (overall matches but ≤2 minor disagreements, severity ≤ low), No Consensus (severity ≥ medium disagreements remain → continue or stalemate).

**Stop triggers**: Full/Partial Consensus; stalemate (same pairs 2 consecutive rounds, no new evidence); hard cap (5 rounds → forced STALEMATE); user stops.

`poll_json.convergence.stalemate === true` → present deadlocked issues with both sides' arguments. Round < 5 → ask user; round 5 → force final synthesis.

**Authority**: Claude orchestration is authoritative for stop/continue. Codex VERDICT is advisory.

### 12. Final Output

Present consensus report — **NEVER modify code. Report + suggest only.**

| Metric | Value |
|--------|-------|
| Rounds | {N} |
| Verdict | CONSENSUS / STALEMATE |
| Claude Findings | {count} |
| Codex Issues | {count} |
| Agreed | {count} |
| Disagreed | {count} |

Present: Files Reviewed (list of files changed), Consensus Points (FINDING↔ISSUE agreed, with suggested fixes), FINDING↔ISSUE Mapping table (Claude FINDING | Codex ISSUE | Classification | Status), Remaining Disagreements (Point | Claude | Codex), Overall Assessment table (Aspect: Code quality/Security posture/Test coverage impression/Maintainability | Claude | Codex | Consensus).

### 13. Finalize + Cleanup
```bash
node "$RUNNER" finalize "$SESSION_DIR" <<'FINALIZE_EOF'
{"verdict":"...","scope":"staged"}
FINALIZE_EOF
```
For last mode: `"scope":"last"`. Optionally include `"issues":{"total_found":N,"total_agreed":N,"total_disagreed":N}`. Report `$SESSION_DIR` path.

```bash
node "$RUNNER" stop "$SESSION_DIR"
```
**Always run cleanup**, even on failure/timeout.

**Errors**:
- `failed` → retry once (re-poll after 15s).
- `timeout` → report partial results from `review.raw_markdown`, suggest lower effort. Run cleanup.
- `stalled` → if `recoverable === true`: `stop` → prepend recovery note → `resume --recovery` → poll (30s, 15s+). If `recoverable === false`: report partial results, suggest lower effort. Run cleanup.
- Start/resume `CODEX_NOT_FOUND` → tell user to install codex.
- **Cleanup sequencing**: run `finalize` + `stop` ONLY after recovery resolves (success or second failure). Do NOT finalize before recovery attempt.

## Rules
- **Safety**: NEVER run `git commit --amend`, `git rebase`, or any command that modifies commit history. This skill is debate-only.
- **No modifications**: NEVER modify code. Report + suggest only. The final output is a consensus report with suggested fixes, not applied changes.
- Both Claude and Codex are equal peers — no reviewer/implementer framing.
- **Information barrier**: Claude MUST complete independent analysis (Step 7) before reading Codex output. This prevents anchoring bias.
- Codex reviews code quality. Commit message quality is secondary — only flag if egregiously bad.
- Discover project context before reviewing (Step 3).
- For `last` mode with N > 1: findings must reference specific commit SHA/subject in Evidence.
- If stalemate persists (same unresolved points for 2 consecutive rounds), present both sides and defer to user.
- **Runner manages all session state** — do NOT manually read/write `rounds.json`, `meta.json`, or `prompt.txt` in the session directory.
