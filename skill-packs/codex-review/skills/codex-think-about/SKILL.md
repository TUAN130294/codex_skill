---
name: codex-think-about
description: Peer debate between Claude Code and Codex on any technical question. Both sides think independently, challenge each other, and converge to consensus or explicit disagreement.
---

# Codex Think About

## Purpose
Use this skill for peer reasoning, not code review. Claude and Codex are equal thinkers.

## Prerequisites
- A clear question or decision topic from the user.
- `codex` CLI installed and authenticated.
- `codex-review` skill pack installed.

## Runner Resolution
Resolve runner from project-local scope first, then global scope:

```bash
RESOLVER=""
SEARCH_DIR="$PWD"
while [ "$SEARCH_DIR" != "/" ]; do
  CANDIDATE="$SEARCH_DIR/.claude/skills/codex-review/skills/codex-think-about/scripts/resolve-runner.sh"
  if [ -x "$CANDIDATE" ]; then
    RESOLVER="$CANDIDATE"
    break
  fi
  SEARCH_DIR=$(dirname "$SEARCH_DIR")
done

if [ -z "$RESOLVER" ] && [ -x "$HOME/.claude/skills/codex-review/skills/codex-think-about/scripts/resolve-runner.sh" ]; then
  RESOLVER="$HOME/.claude/skills/codex-review/skills/codex-think-about/scripts/resolve-runner.sh"
fi

if [ -z "$RESOLVER" ]; then
  echo "Install with codex-skill init -g or codex-skill init" >&2
  exit 1
fi

RUNNER=$(bash "$RESOLVER")
```

## Workflow
1. Gather factual context only (no premature opinion).
2. Build round-1 prompt from `references/prompts.md`.
3. Start Codex thread with `"$RUNNER" start --working-dir "$PWD" --effort "$EFFORT"`.
4. Poll using `"$RUNNER" poll <STATE_DIR>` until terminal status.
5. Claude responds with agree/disagree points and new perspectives.
6. Resume via `--thread-id` and loop until consensus or stalemate.
7. Present user-facing synthesis with agreements, disagreements, and confidence.

## Required References
- Execution loop: `references/workflow.md`
- Prompt templates: `references/prompts.md`
- Output contract: `references/output-format.md`

## Rules
- Keep roles as peers; no reviewer/implementer framing.
- Separate facts from opinions.
- Detect stalemate when arguments repeat with no new evidence.
- End with clear recommendations and open questions.
