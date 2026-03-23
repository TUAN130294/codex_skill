---
name: codex-pr-review
description: Peer debate between Claude Code and Codex on PR quality and merge readiness. Both sides review independently, then debate until consensus — no code modifications made.
---

# Codex PR Review

## Purpose
Use this skill to run peer debate on branch changes before merge — covering code quality, PR description, commit hygiene, scope, and merge readiness. Claude and Codex are equal analytical peers — Claude orchestrates the debate loop and final synthesis. No code is modified.

## When to Use
Before opening or merging a pull request. Covers branch diff, commit history, and PR description together in one pass — more thorough than `/codex-impl-review` for pre-merge scenarios.

## Prerequisites
- Current branch differs from base branch (has commits not in base).
- `git diff <base>...HEAD` produces output.

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

**Base-branch detection**: `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null` (strip prefix); fallback: check `refs/remotes/origin/main` → `origin/master` → `refs/heads/main` → `refs/heads/master` via `git show-ref --verify --quiet`.

**Effort detection** (after base resolved): `FILES_CHANGED=$(git diff --name-only "$BASE"...HEAD | wc -l)` → <10: `medium`, 10–50: `high`, >50: `xhigh`; default `high`.

Announce: `"Detected: base=$BASE, effort=$EFFORT (N files changed). Proceeding — reply to override. PR title/description optional."` Block only if base cannot be resolved.

**Inputs**: base branch (validated: `git rev-parse --verify <base>`), PR title/description (optional), branch diff (`git diff <base>...HEAD`), commit log (`git log <base>..HEAD --oneline`), commit list/count, file stats (`git diff <base>...HEAD --stat`), effort.

### 2. Pre-flight Checks
Verify git repo (`git rev-parse --show-toplevel`). Branch diff: `git diff <base>...HEAD --quiet` must FAIL (exit 1) — else abort "no diff". Commits: `git rev-list --count <base>..HEAD` > 0 — else abort "no commits ahead".

### 3. Init Session
```bash
INIT_OUTPUT=$(node "$RUNNER" init --skill-name codex-pr-review --working-dir "$PWD")
SESSION_DIR=${INIT_OUTPUT#CODEX_SESSION:}
```
Validate: `INIT_OUTPUT` must start with `CODEX_SESSION:`.

### 4. Render Codex Prompt

Template `round1`:
```bash
PROMPT=$(node "$RUNNER" render --skill codex-pr-review --template round1 --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"PR_TITLE":$(json_esc "$PR_TITLE"),"PR_DESCRIPTION":$(json_esc "$PR_DESCRIPTION"),"BASE_BRANCH":$(json_esc "$BASE"),"COMMIT_COUNT":$(json_esc "$COMMIT_COUNT"),"COMMIT_LIST":$(json_esc "$COMMIT_LIST"),"USER_REQUEST":$(json_esc "$USER_REQUEST"),"SESSION_CONTEXT":$(json_esc "$SESSION_CONTEXT")}
RENDER_EOF
)
```

### 5. Start Round 1
```bash
printf '%s' "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --effort "$EFFORT"
```
Validate JSON: `{"status":"started","round":1}`. Error with `CODEX_NOT_FOUND` → tell user to install codex. **Do NOT poll yet — proceed to Step 6.**

### 6. Claude Independent Analysis

**INFORMATION BARRIER**: MUST NOT read any Codex output until analysis is complete.

Render Claude analysis prompt (template `claude-analysis`):
```bash
CLAUDE_PROMPT=$(node "$RUNNER" render --skill codex-pr-review --template claude-analysis --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"PR_TITLE":$(json_esc "$PR_TITLE"),"PR_DESCRIPTION":$(json_esc "$PR_DESCRIPTION"),"BASE_BRANCH":$(json_esc "$BASE"),"COMMIT_COUNT":$(json_esc "$COMMIT_COUNT"),"COMMIT_LIST":$(json_esc "$COMMIT_LIST")}
RENDER_EOF
)
```

**Instructions:**
Read rendered prompt → read diff (`git diff <base>...HEAD`), commits (`git log`, `git show <SHA>`), file stats, PR title/description → write FINDING-{N} per `references/claude-analysis-template.md` → Overall Assessment (Code quality, PR description accuracy, Commit hygiene, Scope appropriateness) → Merge Readiness Pre-Assessment (must-pass status, blocking issues, recommendation) → Strongest Positions. **CRITICAL**: Complete BEFORE Step 7.

### 7. Poll
```bash
POLL_JSON=$(node "$RUNNER" poll "$SESSION_DIR")
```
**Poll intervals**: Round 1: 60s, 60s, 30s, 15s+. Round 2+: 30s, 15s+.

Report **specific activities** from `activities` array (e.g. "Codex [60s]: reading branch diff, analyzing commit hygiene"). NEVER report generic "Codex is running".

Continue while `status === "running"`. Stop on `completed|failed|timeout|stalled`.

### 8. Cross-Analysis
Parse `review.blocks` (each: `id`, `title`, `severity`, `category`, `location`, `problem`, `evidence`) and `review.overall_assessment` (code_quality, pr_description_accuracy, commit_hygiene, scope_appropriateness) from poll JSON. Verdict in `review.verdict.status`. Fallback: `review.raw_markdown`.

**Compare** Claude FINDING-{N} vs Codex ISSUE-{N}:

| Classification | Meaning |
|---------------|---------|
| Agreement | Both independently found same issue |
| Disagreement | Opposing assessment |
| Claude-only | Claude found, Codex did not |
| Codex-only | Codex found, Claude did not |
| Same Direction, Different Severity | Both found, disagree on severity |

**Build response**: 1) Agreements — merged findings. 2) Disagreements — Claude's position + evaluation of Codex's. 3) New findings — Claude-only + evaluation of Codex-only. 4) Set status: CONTINUE/CONSENSUS/STALEMATE. **Claude orchestration is authoritative** — Codex VERDICT is advisory.

### 9. Render Rebuttal + Resume

Template `round2+`:
```bash
PROMPT=$(node "$RUNNER" render --skill codex-pr-review --template round2+ --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"SESSION_CONTEXT":$(json_esc "$SESSION_CONTEXT"),"PR_TITLE":$(json_esc "$PR_TITLE"),"BASE_BRANCH":$(json_esc "$BASE"),"COMMIT_COUNT":$(json_esc "$COMMIT_COUNT"),"COMMIT_LIST":$(json_esc "$COMMIT_LIST"),"AGREED_POINTS":$(json_esc "$AGREED_POINTS"),"DISAGREED_POINTS":$(json_esc "$DISAGREED_POINTS"),"NEW_FINDINGS":$(json_esc "$NEW_FINDINGS"),"CONTINUE_OR_CONSENSUS_OR_STALEMATE":$(json_esc "$STATUS")}
RENDER_EOF
)
```

Resume: `printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --effort "$EFFORT"` → validate JSON. **Go back to step 7 (Poll).** Repeat 7→8→9 until CONSENSUS, STALEMATE, or 5 rounds.

### 10. Completion + Stalemate

**Consensus definitions**: Full (no disagreements), Partial (overall matches but ≤2 minor disagreements, severity ≤ low), No Consensus (severity ≥ medium disagreements remain → continue or stalemate).

**Stop triggers**: Full/Partial Consensus; stalemate (same pairs 2 consecutive rounds, no new evidence); hard cap (5 rounds → forced STALEMATE); user stops.

`poll_json.convergence.stalemate === true` → present deadlocked issues with both sides' arguments. Round < 5 → ask user; round 5 → force final synthesis. Still produce Merge Readiness Scorecard from agreed findings — disagreed findings do not block scorecard.

**Authority**: Claude orchestration is authoritative for stop/continue. Codex VERDICT is advisory.

### 11. Final Output

Present consensus report + merge readiness — **NEVER edit code or create commits**.

**Review Summary:**

| Metric | Value |
|--------|-------|
| Rounds | {N} |
| Verdict | CONSENSUS / STALEMATE |
| Claude Findings | {count} |
| Codex Issues | {count} |
| Agreed | {count} |
| Disagreed | {count} |

Present: FINDING↔ISSUE Mapping table (Claude FINDING | Codex ISSUE | Classification | Status), Consensus Points, Remaining Disagreements (Point | Claude | Codex).

**Overall Assessment:**

| Aspect | Claude | Codex | Consensus |
|--------|--------|-------|-----------|
| Code quality | | | |
| PR description accuracy | | | |
| Commit hygiene | | | |
| Scope appropriateness | | | |

**Merge Readiness Scorecard** (derived from agreed findings only):

| Criterion | Must-pass? | Claude | Codex | Consensus | Status |
|-----------|-----------|--------|-------|-----------|--------|
| Code correctness (bug) | ✅ Yes | | | | |
| Edge case handling | ⚠️ If high+ | | | | |
| Security | ✅ Yes | | | | |
| Performance | ❌ Unless critical | | | | |
| Maintainability | ❌ No | | | | |
| PR description | ❌ No | | | | |
| Commit hygiene | ❌ No | | | | |
| Scope appropriateness | ❌ No | | | | |

Per criterion: **pass** = no agreed finding severity ≥ medium; **concern** = agreed finding severity = medium (non-blocking); **fail** = agreed finding severity ≥ high.

**Merge Recommendation** (priority top-to-bottom, first match):

| # | Condition | Recommendation |
|---|-----------|---------------|
| 1 | Any agreed critical in must-pass (bug, security) | **REJECT** ❌ |
| 2 | ≥3 agreed high in must-pass | **REJECT** ❌ |
| 3 | Any agreed high in must-pass | **REVISE** ⚠️ |
| 4 | Any agreed high in edge-case | **REVISE** ⚠️ |
| 5 | ≥3 agreed medium in must-pass | **REVISE** ⚠️ |
| 6 | All remaining | **MERGE** ✅ |

Must-pass: `bug`, `security`. Conditional: `edge-case` (severity ≥ high → must-pass). Disagreed findings do NOT block merge — if a disagreed finding could change recommendation, note: "⚠️ If {point} confirmed, recommendation → {REVISE/REJECT}."

### 12. Finalize + Cleanup
```bash
node "$RUNNER" finalize "$SESSION_DIR" <<'FINALIZE_EOF'
{"verdict":"...","scope":"branch"}
FINALIZE_EOF
```
Optionally include `"issues":{"total_found":N,"agreed":N,"disagreed":N}`. Report `$SESSION_DIR` path.

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
- **Safety**: NEVER run `git commit`, `git add`, `git rebase`, or any command that modifies code or history. This skill is debate-only.
- Both Claude and Codex are equal peers — no reviewer/implementer framing.
- **Information barrier**: Claude MUST complete independent analysis (Step 6) before reading Codex output. This prevents anchoring bias.
- **NEVER edit code or create commits** — only debate quality and assess merge readiness. The final output is a consensus report + merge readiness scorecard, not a fix.
- Codex reviews only; it does not edit files.
- If stalemate persists (same unresolved points for 2 consecutive rounds), present both sides, produce Merge Readiness Scorecard from agreed findings, and defer to user.
- **Runner manages all session state** — do NOT manually read/write `rounds.json`, `meta.json`, or `prompt.txt` in the session directory.
