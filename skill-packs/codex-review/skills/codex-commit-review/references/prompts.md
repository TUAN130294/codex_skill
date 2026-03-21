# Prompt Templates

## Placeholder Injection Guide

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{COMMIT_MESSAGES}` | Commit message text (draft: user text; last: git log output) | Yes | — |
| `{DIFF_CONTEXT}` | Diff command (draft: `git diff --cached`; last: `git diff HEAD~N..HEAD`) | Yes | — |
| `{USER_REQUEST}` | User's task/request description | No | "Review commit message(s) for quality and accuracy" |
| `{SESSION_CONTEXT}` | Structured context block (see schema below) | No | "Not specified" |
| `{PROJECT_CONVENTIONS}` | Discovered conventions from §1.6 | No | "None discovered — use Git general guidelines" |
| `{OUTPUT_FORMAT}` | Copy entire fenced code block from `references/output-format.md` | Yes | — |
| `{CLAUDE_ANALYSIS_FORMAT}` | Copy entire fenced code block from `references/claude-analysis-template.md` | Yes (Claude analysis only) | — |

### Last-mode additional placeholders

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{COMMIT_LIST}` | Formatted list: `<SHA> <subject>` per commit | Yes (last mode) | — |

### Round 2+ additional placeholders

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{AGREED_POINTS}` | Findings both Claude and Codex agree on (merged descriptions) | Yes | — |
| `{DISAGREED_POINTS}` | Findings where Claude and Codex disagree (both positions) | Yes | — |
| `{NEW_FINDINGS}` | Claude-only or Codex-only findings not yet discussed | Yes | — |
| `{CONTINUE_OR_CONSENSUS_OR_STALEMATE}` | Current debate status with reasoning | Yes | — |

### SESSION_CONTEXT Schema

When user provides context or Claude can infer it, format as:

```
Constraints: {e.g. "team uses 72-char subject line limit"}
Assumptions: {e.g. "this is a squash commit covering multiple changes"}
Tech stack: {languages, frameworks}
Acceptance criteria: {what defines a good commit message for this project}
Review scope: {draft | last N commits}
Project conventions: {PROJECT_CONVENTIONS}
```

---

## Draft Review Prompt (Round 1)
```
## Your Role
You are Codex acting as an equal peer reviewer of commit messages. Another reviewer (Claude) is independently analyzing the same commits — you will debate afterward.

## Task
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Commit Message to Review
{COMMIT_MESSAGES}

## How to Inspect Changes
Run `{DIFF_CONTEXT}` to read the staged diff. Verify the message accurately describes the changes.

## Project Conventions
{PROJECT_CONVENTIONS}

## Instructions
1. Focus on message quality only — do NOT review code correctness.
2. Read the staged diff to verify message accuracy and scope.
3. Check: clarity, convention compliance, scope accuracy, structure.
4. Verify message claims match the actual diff.
5. Focus on identifying problems and their impact — do NOT suggest fixes.
6. Use EXACT output format below.

## Required Output Format
{OUTPUT_FORMAT}
```

## Last Review Prompt (Round 1)
```
## Your Role
You are Codex acting as an equal peer reviewer of commit messages. Another reviewer (Claude) is independently analyzing the same commits — you will debate afterward.

## Task
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Commits to Review
{COMMIT_LIST}

## Commit Messages
{COMMIT_MESSAGES}

## How to Inspect Changes
- For each commit, run `git show <SHA>` to see its individual diff.
- Also run `{DIFF_CONTEXT}` for aggregate diff context.
- Verify each message accurately describes its commit's changes.

## Project Conventions
{PROJECT_CONVENTIONS}

## Instructions
1. Focus on message quality only — do NOT review code correctness.
2. Inspect EACH commit's diff individually — do not rely on aggregate diff alone.
3. Check: clarity, convention compliance, scope accuracy, structure.
4. Verify each message's claims match its actual diff.
5. In Evidence field, always reference the specific commit SHA and subject.
6. Focus on identifying problems and their impact — do NOT suggest fixes.
7. Use EXACT output format below.

## Required Output Format
{OUTPUT_FORMAT}
```

## Claude Independent Analysis Prompt — Draft mode
```
## Your Task
You are reviewing commit message(s) independently. Codex is reviewing the same commits separately — you will NOT see their findings until later.

## INFORMATION BARRIER
- Do NOT read $SESSION_DIR/review.md or any Codex output.
- Form your OWN conclusions based on the diff and message text.
- Commit to specific positions.

## Commit Message to Review
{COMMIT_MESSAGES}

## How to Inspect Changes
Run `{DIFF_CONTEXT}` to read the staged diff. Verify the message accurately describes the changes.

## Project Conventions
{PROJECT_CONVENTIONS}

## Instructions
1. Focus on message quality only — do NOT review code correctness.
2. Read the diff to verify message accuracy and scope.
3. Check: clarity, convention compliance, scope accuracy, structure.
4. Identify problems — do NOT suggest fixes.
5. Write in the required format below.

## Required Output Format
{CLAUDE_ANALYSIS_FORMAT}
```

## Claude Independent Analysis Prompt — Last mode
```
## Your Task
You are reviewing commit message(s) independently. Codex is reviewing the same commits separately — you will NOT see their findings until later.

## INFORMATION BARRIER
- Do NOT read $SESSION_DIR/review.md or any Codex output.
- Form your OWN conclusions based on the diff and message text.
- Commit to specific positions.

## Commits to Review
{COMMIT_LIST}

## Commit Messages
{COMMIT_MESSAGES}

## How to Inspect Changes
- For each commit, run `git show <SHA>` to see its individual diff.
- Also run `{DIFF_CONTEXT}` for aggregate diff context.
- Verify each message accurately describes its commit's changes.

## Project Conventions
{PROJECT_CONVENTIONS}

## Instructions
1. Focus on message quality only — do NOT review code correctness.
2. Inspect EACH commit's diff individually — do not rely on aggregate diff alone.
3. Check: clarity, convention compliance, scope accuracy, structure.
4. In Evidence field, always reference the specific commit SHA and subject.
5. Identify problems — do NOT suggest fixes.
6. Write in the required format below.

## Required Output Format
{CLAUDE_ANALYSIS_FORMAT}
```

## Response Prompt — Draft mode (Round 2+)
```
## Session Context
{SESSION_CONTEXT}

## Project Conventions
{PROJECT_CONVENTIONS}

## Points We Agree On
{AGREED_POINTS}

## Points We Disagree On
{DISAGREED_POINTS}

## New Findings
{NEW_FINDINGS}

## Current Status
{CONTINUE_OR_CONSENSUS_OR_STALEMATE}

## Instructions
1. Re-read the staged diff: run `{DIFF_CONTEXT}`.
2. Address disagreements with evidence from the diff.
3. Do NOT suggest fixes — focus on whether the problem exists.
4. Keep ISSUE-{N} numbering stable. New findings use the next available number.
5. Use EXACT output format. You MUST include a VERDICT block.

## Required Output Format
{OUTPUT_FORMAT}
```

## Response Prompt — Last mode (Round 2+)
```
## Session Context
{SESSION_CONTEXT}

## Project Conventions
{PROJECT_CONVENTIONS}

## Commits in Scope
{COMMIT_LIST}

## Points We Agree On
{AGREED_POINTS}

## Points We Disagree On
{DISAGREED_POINTS}

## New Findings
{NEW_FINDINGS}

## Current Status
{CONTINUE_OR_CONSENSUS_OR_STALEMATE}

## Instructions
1. Re-read each commit's diff: run `git show <SHA>` for each commit in the review. Also run `{DIFF_CONTEXT}` for aggregate context.
2. Address disagreements with evidence from the diff.
3. In Evidence, always reference specific commit SHA and subject.
4. Do NOT suggest fixes — focus on whether the problem exists.
5. Keep ISSUE-{N} numbering stable. New findings use the next available number.
6. Use EXACT output format. You MUST include a VERDICT block.

## Required Output Format
{OUTPUT_FORMAT}
```
