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
- `codex-review` skill pack is installed (global or project scope).

## Runner Resolution
Resolve runner from project-local scope first, then global scope:

```bash
RESOLVER=""
SEARCH_DIR="$PWD"
while [ "$SEARCH_DIR" != "/" ]; do
  CANDIDATE="$SEARCH_DIR/.claude/skills/codex-review/skills/codex-impl-review/scripts/resolve-runner.sh"
  if [ -x "$CANDIDATE" ]; then
    RESOLVER="$CANDIDATE"
    break
  fi
  SEARCH_DIR=$(dirname "$SEARCH_DIR")
done

if [ -z "$RESOLVER" ] && [ -x "$HOME/.claude/skills/codex-review/skills/codex-impl-review/scripts/resolve-runner.sh" ]; then
  RESOLVER="$HOME/.claude/skills/codex-review/skills/codex-impl-review/scripts/resolve-runner.sh"
fi

if [ -z "$RESOLVER" ]; then
  echo "Install with codex-skill init -g or codex-skill init" >&2
  exit 1
fi

RUNNER=$(bash "$RESOLVER")
```

## Workflow
1. Gather diff context (`git status`, `git diff`, optional plan file).
2. Build prompt from `references/prompts.md` (`Implementation Review Prompt`).
3. Start round 1 with `"$RUNNER" start --working-dir "$PWD" --effort "$EFFORT"`.
4. Poll via `"$RUNNER" poll <STATE_DIR>` every ~15 seconds.
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
