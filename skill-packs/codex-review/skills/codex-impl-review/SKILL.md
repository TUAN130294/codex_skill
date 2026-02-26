---
name: codex-impl-review
description: Have Codex CLI review uncommitted code changes. Claude applies valid fixes, rebuts invalid points, and iterates until consensus or user-approved stalemate.
---

# Codex Implementation Review

## Purpose
Use this skill to run adversarial review on uncommitted changes before commit.

## Prerequisites
- Working tree has staged or unstaged changes.
- `codex` CLI is installed and authenticated.
- `codex-review` skill pack is installed (`npx github:lploc94/codex_skill`).

## Runner

```bash
RUNNER="{{RUNNER_PATH}}"
```

## Workflow
1. **Ask user** to choose review effort level: `low`, `medium`, `high`, or `xhigh` (default: `high`). Gather diff context (`git status`, `git diff`, optional plan file). Set `EFFORT` to their choice.
2. Build prompt from `references/prompts.md` (`Implementation Review Prompt`).
3. Start round 1 with `node "$RUNNER" start --working-dir "$PWD" --effort "$EFFORT"`.
4. Poll with adaptive intervals (Round 1: 60s/60s/30s/15s..., Round 2+: 30s/15s...). Report Codex status to user after each poll.
5. Parse issue list with `references/output-format.md`.
6. Fix valid issues in code; rebut invalid findings with evidence.
7. Resume debate via `--thread-id` until `APPROVE` or stalemate.
8. Return final review summary and unresolved risks.

## Required References
- Detailed execution: `references/workflow.md`
- Prompt templates: `references/prompts.md`
- Output contract: `references/output-format.md`

## Rules
- Codex reviews only; it does not edit files.
- Preserve functional intent unless fix requires behavior change.
- Every accepted issue must map to a concrete code diff.
- If stalemate persists, present both sides and defer to user.
