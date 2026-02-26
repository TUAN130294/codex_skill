#!/usr/bin/env bash
set -euo pipefail

if [ -n "${CODEX_RUNNER:-}" ] && [ -x "${CODEX_RUNNER}" ]; then
  printf '%s\n' "${CODEX_RUNNER}"
  exit 0
fi

SEARCH_DIR="$PWD"
while [ "$SEARCH_DIR" != "/" ]; do
  CANDIDATE="$SEARCH_DIR/.claude/skills/codex-review/skills/codex-think-about/scripts/codex-runner.sh"
  if [ -x "$CANDIDATE" ]; then
    printf '%s\n' "$CANDIDATE"
    exit 0
  fi
  SEARCH_DIR=$(dirname "$SEARCH_DIR")
done

GLOBAL_RUNNER="$HOME/.claude/skills/codex-review/skills/codex-think-about/scripts/codex-runner.sh"
if [ -x "$GLOBAL_RUNNER" ]; then
  printf '%s\n' "$GLOBAL_RUNNER"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SCRIPT_DIR/codex-runner.sh" ]; then
  printf '%s\n' "$SCRIPT_DIR/codex-runner.sh"
  exit 0
fi

echo "Unable to resolve codex-runner.sh for codex-think-about." >&2
echo "Install with 'codex-skill init -g' or 'codex-skill init'." >&2
exit 1
