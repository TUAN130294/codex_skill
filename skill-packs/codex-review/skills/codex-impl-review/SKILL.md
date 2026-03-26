---
name: codex-impl-review
description: Review uncommitted code changes or branch diff. Claude applies valid fixes, rebuts invalid points, iterates until consensus or stalemate.
---

# Codex Implementation Review

## Purpose
Adversarial review on uncommitted changes before commit, or branch changes before merge.

## When to Use
After writing code, before committing. For security-sensitive code, run `/codex-security-review` alongside.

## Prerequisites
- **Working-tree** (default): staged or unstaged changes exist.
- **Branch**: current branch differs from base branch.

## Runner
RUNNER="{{RUNNER_PATH}}"
SKILLS_DIR="{{SKILLS_DIR}}"
json_esc() { printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(d)))'; }

## Critical Rules (DO NOT skip)
- Stdin: `printf '%s' "$PROMPT" | node "$RUNNER" ...` -- NEVER `echo`. JSON via heredoc.
- Validate: `init` output must start with `CODEX_SESSION:`. `start`/`resume` must return valid JSON. `CODEX_NOT_FOUND`->tell user install codex.
- `status === "completed"` means **Codex's turn is done** -- NOT that the debate is over. MUST check Loop Decision table.
- Loop: Do NOT exit unless APPROVE or stalemate. No round cap.
- Errors: `failed`->retry once (re-poll 15s). `timeout`->report partial, suggest lower effort. `stalled`+recoverable->`stop`->recovery `resume`->poll; not recoverable->report partial. Cleanup sequencing: `finalize`+`stop` ONLY after recovery resolves.
- Cleanup: ALWAYS run `finalize` + `stop`, even on failure/timeout.
- Runner manages all session state -- NEVER read/write session files manually.
- For poll intervals and detailed error flows -> `Read references/protocol.md`

## Workflow

### 1. Collect Inputs
Scope: working-tree (staged/unstaged changes) or branch (diff vs base). Auto-detect via `git status --short` and `git rev-list @{u}..HEAD`.
Effort: <10 files=`medium`, 10-50=`high`, >50=`xhigh`. Announce defaults.
Working-tree inputs: working dir, user request, uncommitted changes.
Branch inputs: base branch (validate `git rev-parse --verify`), clean working tree required, branch diff + commit log.

### 2. Pre-flight
Working-tree: `git diff --quiet && git diff --cached --quiet` must FAIL. Branch: `git diff <base>...HEAD --quiet` must FAIL.

### 3. Init + Render + Start
Init: `node "$RUNNER" init --skill-name codex-impl-review --working-dir "$PWD"`
Render: template=`working-tree-round1` or `branch-round1`. Placeholders: `USER_REQUEST`, `SESSION_CONTEXT`, `BASE_BRANCH` (branch only).
Start: `printf '%s' "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --effort "$EFFORT"`

### 4. Poll -> Check Verdict -> Apply/Rebut -> Resume Loop

Poll + report activities. (-> `references/protocol.md` for intervals)
Parse `review.blocks[]` (id, title, severity, category, location, problem, suggested_fix). Verdict in `review.verdict.status`.

**Check stalemate FIRST, then verdict** (-> `references/protocol.md` § Debate Loop Protocol):

| # | Condition | Action |
|---|-----------|--------|
| 1 | convergence.stalemate === true | **EXIT** -> step 5 (stalemate). Do NOT render rebuttal. |
| 2 | verdict === "APPROVE" | **EXIT** -> step 5 |
| 3 | verdict === "REVISE" or open issues | **CONTINUE** -> sub-steps below |

**If CONTINUE** — all 4 sub-steps are MANDATORY, even if you fix every issue:
1. **Categorize** each `review.blocks[]` issue: ACCEPT (valid) or DISPUTE (invalid with concrete proof). Verify fixes (tests/typecheck).
2. **Fix** accepted issues -> edit code, record evidence. Branch mode: commit fixes before resume. Invalid -> rebut with concrete proof.
3. **ALWAYS render rebuttal** — template=`rebuttal-working-tree` or `rebuttal-branch`. Placeholders: `USER_REQUEST`, `SESSION_CONTEXT`, `FIXED_ITEMS`, `DISPUTED_ITEMS`, `BASE_BRANCH`. If all issues fixed, `DISPUTED_ITEMS` = `"None — all issues addressed"`. Rebuttal is NEVER skipped.
4. **ALWAYS resume** — `printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --effort "$EFFORT"`. Back to **Poll**. Codex MUST re-verify fixes and may find new issues.

### 5. Completion + Output
APPROVE -> done. Stalemate -> present deadlocked issues, ask user.
Report: Rounds, Verdict, Issues Found/Fixed/Disputed, fixed defects by severity, residual risks, next steps.

### 6. Finalize + Cleanup
`finalize` + `stop`. Always run. (-> `references/protocol.md` for error handling)

## Flavor Text Triggers
SKILL_START, POLL_WAITING, CODEX_RETURNED, APPLY_FIX, SEND_REBUTTAL, LATE_ROUND, APPROVE_VICTORY, STALEMATE_DRAW, FINAL_SUMMARY

## Rules
- If in plan mode, exit plan mode first -- this skill requires code editing.
- Codex reviews only; it does not edit files. Preserve functional intent unless fix requires behavior change.
- Every accepted issue -> concrete code diff.
