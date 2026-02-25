---
name: codex-impl-review
description: Have Codex CLI review uncommitted code changes. Claude Code then fixes valid issues and rebuts invalid ones. Codex re-reviews. Repeat until consensus. Codex never touches code — it only reviews.
---

# Codex Implementation Review — Skill Guide

## Overview
This skill sends uncommitted changes to Codex CLI for **review only**. Codex reads the diff itself, finds bugs/edge cases/security issues, and reports back. Claude Code then evaluates the review — fixes what's valid, pushes back on what's not — and sends the updated diff back to Codex for re-review. This repeats until both sides agree the code is solid.

**Codex NEVER modifies code.** It only reads and reviews. All fixes are done by Claude Code.

**Flow:** Point Codex to the repo → Codex reads diff + plan → Codex reviews → Claude Code fixes & rebuts → Codex re-reviews → ... → Consensus → Done

## Prerequisites
- There must be uncommitted changes (staged or unstaged) in the working directory.
- The Codex CLI (`codex`) must be installed and available in PATH.

## Codex Runner Script

This skill uses `codex-runner.sh` with `start`/`poll`/`stop` subcommands to run Codex CLI in the background and report progress incrementally.

- **`start`** — launches Codex as a detached background process, returns immediately with a state directory path
- **`poll`** — checks progress, outputs plain text status on stdout and progress events on stderr
- **`stop`** — kills processes and cleans up the state directory

### Bootstrap Logic (inline in every Bash call)

Every Bash call that invokes the runner must include this resolve block at the top:

```bash
RUNNER="${CODEX_RUNNER:-$HOME/.local/bin/codex-runner.sh}"
NEED_INSTALL=0
if [ -n "$CODEX_RUNNER" ] && test -x "$CODEX_RUNNER"; then
  if ! grep -q 'CODEX_RUNNER_VERSION="5"' "$CODEX_RUNNER" 2>/dev/null; then NEED_INSTALL=1; fi
elif ! test -x "$RUNNER"; then NEED_INSTALL=1
elif ! grep -q 'CODEX_RUNNER_VERSION="5"' "$RUNNER" 2>/dev/null; then NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  TMP=$(mktemp "$HOME/.local/bin/codex-runner.XXXXXX")
  cat > "$TMP" <<'RUNNER_SCRIPT'
<EMBEDDED_SCRIPT_CONTENT>
RUNNER_SCRIPT
  chmod +x "$TMP"
  mv "$TMP" "$HOME/.local/bin/codex-runner.sh"
  RUNNER="$HOME/.local/bin/codex-runner.sh"
fi
```

Where `<EMBEDDED_SCRIPT_CONTENT>` is the full content of the codex-runner.sh script below:

```bash
#!/usr/bin/env bash
set -euo pipefail

# IMPORTANT: Bump CODEX_RUNNER_VERSION when changing this script.
# embed-runner.sh checks this version string across all embed locations.
CODEX_RUNNER_VERSION="5"

# --- Exit codes ---
EXIT_SUCCESS=0
EXIT_ERROR=1
EXIT_TIMEOUT=2
EXIT_TURN_FAILED=3
EXIT_STALLED=4
EXIT_CODEX_NOT_FOUND=5

# --- Subcommand dispatch ---
case "${1:-}" in
  start) shift; do_start=1 ;;
  poll)  shift; do_poll=1 ;;
  stop)  shift; do_stop=1 ;;
  *)     do_legacy=1 ;;
esac

# ============================================================
# SUBCOMMAND: start
# ============================================================
if [[ "${do_start:-}" == 1 ]]; then

  # --- Defaults ---
  WORKING_DIR=""
  EFFORT="high"
  THREAD_ID=""
  TIMEOUT=3600

  # --- Parse arguments ---
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --working-dir) WORKING_DIR="$2"; shift 2 ;;
      --effort) EFFORT="$2"; shift 2 ;;
      --thread-id) THREAD_ID="$2"; shift 2 ;;
      --timeout) TIMEOUT="$2"; shift 2 ;;
      --version) echo "codex-runner $CODEX_RUNNER_VERSION"; exit 0 ;;
      *) echo "Unknown option: $1" >&2; exit $EXIT_ERROR ;;
    esac
  done

  # --- Validate ---
  if [[ -z "$WORKING_DIR" ]]; then
    echo "Error: --working-dir is required" >&2
    exit $EXIT_ERROR
  fi
  if ! command -v codex &>/dev/null; then
    echo "Error: codex CLI not found in PATH" >&2
    exit $EXIT_CODEX_NOT_FOUND
  fi

  # --- Canonicalize WORKING_DIR ---
  WORKING_DIR_REAL=$(realpath "$WORKING_DIR")
  WORKING_DIR="$WORKING_DIR_REAL"

  # --- Read prompt from stdin ---
  PROMPT=$(cat)
  if [[ -z "$PROMPT" ]]; then
    echo "Error: no prompt provided on stdin" >&2
    exit $EXIT_ERROR
  fi

  # --- Create state directory ---
  RUN_ID="$(date +%s)-$$"
  STATE_DIR="${WORKING_DIR}/.codex-review/runs/${RUN_ID}"
  mkdir -p "$STATE_DIR"

  # Write prompt to file
  printf '%s' "$PROMPT" > "$STATE_DIR/prompt.txt"

  # --- Startup rollback trap ---
  # If anything fails before state.json is committed, clean up everything
  startup_cleanup() {
    local pgid="${CODEX_PGID:-}"
    if [[ -n "$pgid" ]]; then
      kill -TERM -"$pgid" 2>/dev/null || true
    fi
    local wpid="${WATCHDOG_PID:-}"
    if [[ -n "$wpid" ]] && kill -0 "$wpid" 2>/dev/null; then
      kill "$wpid" 2>/dev/null || true
    fi
    rm -rf "$STATE_DIR"
  }
  trap startup_cleanup EXIT

  # --- Detach Codex process via Python3 launcher ---
  LAUNCH_RESULT=$(python3 -c "
import os, sys, json, subprocess

state_dir = sys.argv[1]
working_dir = sys.argv[2]
timeout_s = int(sys.argv[3])
thread_id = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else ''
effort = sys.argv[5] if len(sys.argv) > 5 else 'high'

prompt_file = os.path.join(state_dir, 'prompt.txt')
jsonl_file = os.path.join(state_dir, 'output.jsonl')
err_file = os.path.join(state_dir, 'error.log')

if thread_id:
    cmd = ['codex', 'exec', '--skip-git-repo-check', '--json', 'resume', thread_id]
    cwd = working_dir
else:
    cmd = ['codex', 'exec', '--skip-git-repo-check', '--json',
           '--sandbox', 'read-only',
           '--config', 'model_reasoning_effort=' + effort,
           '-C', working_dir]
    cwd = None

with open(prompt_file) as fin, open(jsonl_file, 'w') as fout, open(err_file, 'w') as ferr:
    p = subprocess.Popen(cmd, stdin=fin, stdout=fout, stderr=ferr,
                         cwd=cwd, start_new_session=True)

print(json.dumps({'pid': p.pid, 'pgid': p.pid}))
" "$STATE_DIR" "$WORKING_DIR" "$TIMEOUT" "$THREAD_ID" "$EFFORT")

  CODEX_PID=$(echo "$LAUNCH_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['pid'])")
  CODEX_PGID=$(echo "$LAUNCH_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['pgid'])")

  # --- Watchdog timeout (detached) ---
  python3 -c "
import os, signal, time, sys
os.setsid()
time.sleep(int(sys.argv[1]))
try:
    os.killpg(int(sys.argv[2]), signal.SIGTERM)
except ProcessLookupError:
    pass
" "$TIMEOUT" "$CODEX_PGID" &
  WATCHDOG_PID=$!
  disown $WATCHDOG_PID 2>/dev/null || true

  # --- Verify process is alive ---
  sleep 1
  if ! kill -0 "$CODEX_PID" 2>/dev/null; then
    echo "Error: Codex process died immediately after launch" >&2
    # startup_cleanup trap will handle the rest
    exit $EXIT_ERROR
  fi

  # --- Write state.json (atomic: tmp -> mv) ---
  NOW=$(date +%s)
  STATE_TMP=$(mktemp "$STATE_DIR/state.json.XXXXXX")
  python3 -c "
import json, sys
data = {
    'pid': int(sys.argv[1]),
    'pgid': int(sys.argv[2]),
    'watchdog_pid': int(sys.argv[3]),
    'run_id': sys.argv[4],
    'state_dir': sys.argv[5],
    'working_dir': sys.argv[6],
    'effort': sys.argv[7],
    'timeout': int(sys.argv[8]),
    'started_at': int(sys.argv[9]),
    'thread_id': sys.argv[10],
    'last_line_count': 0,
    'stall_count': 0,
    'last_poll_at': 0
}
with open(sys.argv[11], 'w') as f:
    json.dump(data, f, indent=2)
" "$CODEX_PID" "$CODEX_PGID" "$WATCHDOG_PID" "$RUN_ID" "$STATE_DIR" "$WORKING_DIR" "$EFFORT" "$TIMEOUT" "$NOW" "$THREAD_ID" "$STATE_TMP"
  mv "$STATE_TMP" "$STATE_DIR/state.json"

  # --- State committed: remove startup trap ---
  trap - EXIT

  # --- Output result ---
  echo "CODEX_STARTED:${STATE_DIR}"
  exit $EXIT_SUCCESS
fi

# ============================================================
# SUBCOMMAND: poll
# ============================================================
if [[ "${do_poll:-}" == 1 ]]; then

  STATE_DIR="${1:-}"
  if [[ -z "$STATE_DIR" ]]; then
    echo "POLL:failed:0s:1:Invalid or missing state directory"
    exit $EXIT_ERROR
  fi

  # Validate STATE_DIR: realpath + directory exists + state.json + reconstruct from working_dir+run_id
  STATE_DIR_REAL=$(realpath "$STATE_DIR" 2>/dev/null || true)
  if [[ -z "$STATE_DIR_REAL" || ! -d "$STATE_DIR_REAL" ]]; then
    echo "POLL:failed:0s:1:Invalid or missing state directory"
    exit $EXIT_ERROR
  fi
  STATE_DIR="$STATE_DIR_REAL"

  # --- Read state ---
  if [[ ! -f "$STATE_DIR/state.json" ]]; then
    echo "POLL:failed:0s:1:state.json not found"
    exit $EXIT_ERROR
  fi

  # Reconstruct expected path from state.json and compare
  VALIDATE_RESULT=$(python3 -c "
import sys, json, os
with open(sys.argv[1]) as f:
    s = json.load(f)
wd = os.path.realpath(s.get('working_dir', ''))
rid = s.get('run_id', '')
expected = os.path.join(wd, '.codex-review', 'runs', rid)
actual = os.path.realpath(sys.argv[2])
print('OK' if expected == actual else 'MISMATCH')
" "$STATE_DIR/state.json" "$STATE_DIR" 2>/dev/null || echo "ERROR")

  if [[ "$VALIDATE_RESULT" == "MISMATCH" ]]; then
    # Fallback: check old /tmp format for migration
    if [[ "$STATE_DIR_REAL" =~ ^(/tmp|/private/tmp)/codex-runner-[0-9]+-[0-9]+$ ]]; then
      echo "[migration] Accepting legacy /tmp state directory" >&2
    else
      echo "POLL:failed:0s:1:state directory path mismatch"
      exit $EXIT_ERROR
    fi
  elif [[ "$VALIDATE_RESULT" != "OK" ]]; then
    echo "POLL:failed:0s:1:state.json validation error"
    exit $EXIT_ERROR
  fi

  # --- Check for cached final result (idempotent, after validation) ---
  if [[ -f "$STATE_DIR/final.txt" ]]; then
    cat "$STATE_DIR/final.txt"
    if [[ -f "$STATE_DIR/review.txt" ]]; then
      echo "[cached] Review available in $STATE_DIR/review.txt" >&2
    fi
    exit $EXIT_SUCCESS
  fi

  # Parse state.json with python3
  STATE_VALS=$(python3 -c "
import sys, json, time
with open(sys.argv[1]) as f:
    s = json.load(f)
print(s.get('pid', ''))
print(s.get('pgid', ''))
print(s.get('watchdog_pid', ''))
print(s.get('timeout', 3600))
print(s.get('started_at', int(time.time())))
print(s.get('last_line_count', 0))
print(s.get('stall_count', 0))
print(s.get('thread_id', ''))
" "$STATE_DIR/state.json")

  CODEX_PID=$(echo "$STATE_VALS" | sed -n '1p')
  CODEX_PGID=$(echo "$STATE_VALS" | sed -n '2p')
  WATCHDOG_PID=$(echo "$STATE_VALS" | sed -n '3p')
  TIMEOUT=$(echo "$STATE_VALS" | sed -n '4p')
  STARTED_AT=$(echo "$STATE_VALS" | sed -n '5p')
  LAST_LINE_COUNT=$(echo "$STATE_VALS" | sed -n '6p')
  STALL_COUNT=$(echo "$STATE_VALS" | sed -n '7p')
  THREAD_ID=$(echo "$STATE_VALS" | sed -n '8p')

  JSONL_FILE="$STATE_DIR/output.jsonl"
  ERR_FILE="$STATE_DIR/error.log"
  NOW=$(date +%s)
  ELAPSED=$((NOW - STARTED_AT))

  # --- Check if PID is alive ---
  PROCESS_ALIVE=1
  if ! kill -0 "$CODEX_PID" 2>/dev/null; then
    PROCESS_ALIVE=0
  fi

  # --- Count lines ---
  CURRENT_LINE_COUNT=0
  if [[ -f "$JSONL_FILE" ]]; then
    CURRENT_LINE_COUNT=$(wc -l < "$JSONL_FILE" 2>/dev/null || echo 0)
    CURRENT_LINE_COUNT=$(echo "$CURRENT_LINE_COUNT" | tr -d ' ')
  fi

  # --- Stall detection ---
  NEW_STALL_COUNT=$STALL_COUNT
  if [[ "$CURRENT_LINE_COUNT" -eq "$LAST_LINE_COUNT" ]]; then
    NEW_STALL_COUNT=$((STALL_COUNT + 1))
  else
    NEW_STALL_COUNT=0
  fi

  # --- Helper: verify PID belongs to codex before killing ---
  # Uses ps -o args= to check full command line for "codex exec" pattern.
  # Verifies PGID matches expected value to prevent killing wrong process group.
  # Falls back to kill-by-existence if ps is unavailable (e.g., sandboxed environments).
  verify_and_kill_codex() {
    local pid="$1" pgid="$2"
    if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
    local args current_pgid
    args=$(ps -p "$pid" -o args= 2>/dev/null || true)
    if [[ -z "$args" ]]; then
      # ps unavailable — fallback to kill-by-existence (original behavior)
      kill -TERM -"$pgid" 2>/dev/null || true
      return 0
    fi
    if [[ "$args" == *"codex exec"* ]]; then
      # Verify PGID matches before killing the group
      current_pgid=$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ' || true)
      if [[ "$current_pgid" == "$pgid" ]]; then
        kill -TERM -"$pgid" 2>/dev/null || true
      fi
    fi
  }
  verify_and_kill_watchdog() {
    local pid="$1"
    if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
    local args
    args=$(ps -p "$pid" -o args= 2>/dev/null || true)
    if [[ -z "$args" ]]; then
      # ps unavailable — fallback
      kill "$pid" 2>/dev/null || true
      return 0
    fi
    if [[ "$args" == *python* && "$args" == *"time.sleep"* ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  }

  # --- Helper: write final.txt and kill processes ---
  write_final_and_cleanup() {
    local final_content="$1"
    local final_tmp
    final_tmp=$(mktemp "$STATE_DIR/final.txt.XXXXXX")
    printf '%s' "$final_content" > "$final_tmp"
    mv "$final_tmp" "$STATE_DIR/final.txt"
    # Kill Codex process group if verified
    verify_and_kill_codex "$CODEX_PID" "$CODEX_PGID"
    # Kill watchdog if verified
    if [[ -n "$WATCHDOG_PID" ]]; then
      verify_and_kill_watchdog "$WATCHDOG_PID"
    fi
  }

  # --- Parse JSONL events (BEFORE timeout/stall checks) ---
  # Terminal events take priority: if Codex finished, we want the result
  # even if we're past the timeout window.
  # Python3 script outputs:
  #   stdout: POLL:<status>:<elapsed>s[:...] lines
  #   stderr: [Xs] progress messages
  #   Writes review.txt if completed
  POLL_OUTPUT=$(python3 -c "
import sys, json, os

state_dir = sys.argv[1]
last_line_count = int(sys.argv[2])
elapsed = int(sys.argv[3])
process_alive = int(sys.argv[4])
timeout_val = int(sys.argv[5]) if len(sys.argv) > 5 else 0

jsonl_file = os.path.join(state_dir, 'output.jsonl')
err_file = os.path.join(state_dir, 'error.log')

all_lines = []
turn_completed = False
turn_failed = False
turn_failed_msg = ''
extracted_thread_id = ''
review_text = ''

if os.path.isfile(jsonl_file):
    with open(jsonl_file) as f:
        all_lines = f.readlines()

# Parse ALL lines for terminal state + data extraction
for line in all_lines:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        continue
    t = d.get('type', '')

    # Thread ID from thread.started event
    if t == 'thread.started' and d.get('thread_id'):
        extracted_thread_id = d['thread_id']

    # Terminal states
    if t == 'turn.completed':
        turn_completed = True
    elif t == 'turn.failed':
        turn_failed = True
        turn_failed_msg = d.get('error', {}).get('message', 'unknown error')

    # Review text from agent_message (inside item.completed)
    if t == 'item.completed':
        item = d.get('item', {})
        if item.get('type') == 'agent_message':
            review_text = item.get('text', '')

# Parse NEW lines for progress events -> stderr
new_lines = all_lines[last_line_count:]
for line in new_lines:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        continue
    t = d.get('type', '')
    item = d.get('item', {})
    item_type = item.get('type', '')

    if t == 'turn.started':
        print(f'[{elapsed}s] Codex is thinking...', file=sys.stderr)
    elif t == 'item.completed' and item_type == 'reasoning':
        text = item.get('text', '')
        if len(text) > 150:
            text = text[:150] + '...'
        print(f'[{elapsed}s] Codex thinking: {text}', file=sys.stderr)
    elif t == 'item.started' and item_type == 'command_execution':
        cmd = item.get('command', '')
        print(f'[{elapsed}s] Codex running: {cmd}', file=sys.stderr)
    elif t == 'item.completed' and item_type == 'command_execution':
        cmd = item.get('command', '')
        print(f'[{elapsed}s] Codex completed: {cmd}', file=sys.stderr)
    elif t == 'item.completed' and item_type == 'file_change':
        changes = item.get('changes', [])
        for c in changes:
            path = c.get('path', '?')
            kind = c.get('kind', '?')
            print(f'[{elapsed}s] Codex changed: {path} ({kind})', file=sys.stderr)

# Helper: sanitize message to single line
def sanitize_msg(s):
    import re
    if s is None:
        return 'unknown error'
    return re.sub(r'\s+', ' ', str(s)).strip()

# Determine status and output to stdout
if turn_completed:
    if not extracted_thread_id or not review_text:
        error_detail = 'no thread_id' if not extracted_thread_id else 'no agent_message'
        print(f'POLL:failed:{elapsed}s:1:turn.completed but {error_detail}')
    else:
        # Write review to file
        review_path = os.path.join(state_dir, 'review.txt')
        with open(review_path, 'w') as f:
            f.write(review_text)
        print(f'POLL:completed:{elapsed}s')
        print(f'THREAD_ID:{extracted_thread_id}')
elif turn_failed:
    print(f'POLL:failed:{elapsed}s:3:Codex turn failed: {sanitize_msg(turn_failed_msg)}')
elif not process_alive:
    if timeout_val > 0 and elapsed >= timeout_val:
        print(f'POLL:timeout:{elapsed}s:2:Timeout after {timeout_val}s')
    else:
        err_content = ''
        if os.path.isfile(err_file):
            with open(err_file) as f:
                err_content = f.read().strip()
        error_msg = 'Codex process exited unexpectedly'
        if err_content:
            error_msg += ': ' + sanitize_msg(err_content[:200])
        print(f'POLL:failed:{elapsed}s:1:{error_msg}')
else:
    print(f'POLL:running:{elapsed}s')
" "$STATE_DIR" "$LAST_LINE_COUNT" "$ELAPSED" "$PROCESS_ALIVE" "$TIMEOUT" 2>&2)

  # Parse first line for status
  POLL_STATUS=$(echo "$POLL_OUTPUT" | head -1 | cut -d: -f2)

  if [[ "$POLL_STATUS" != "running" ]]; then
    # Terminal state — write final.txt and cleanup
    write_final_and_cleanup "$POLL_OUTPUT"
  else
    # --- Only check timeout/stall when still running (no terminal event yet) ---
    if [[ $ELAPSED -ge $TIMEOUT ]]; then
      POLL_OUTPUT="POLL:timeout:${ELAPSED}s:${EXIT_TIMEOUT}:Timeout after ${TIMEOUT}s"
      write_final_and_cleanup "$POLL_OUTPUT"
      POLL_STATUS="timeout"
    elif [[ $NEW_STALL_COUNT -ge 12 && $PROCESS_ALIVE -eq 1 ]]; then
      POLL_OUTPUT="POLL:stalled:${ELAPSED}s:${EXIT_STALLED}:No new output for ~3 minutes"
      write_final_and_cleanup "$POLL_OUTPUT"
      POLL_STATUS="stalled"
    fi
  fi

  # --- Update state.json (atomic) ---
  STATE_TMP=$(mktemp "$STATE_DIR/state.json.XXXXXX")
  python3 -c "
import sys, json
with open(sys.argv[1]) as f:
    s = json.load(f)
s['last_line_count'] = int(sys.argv[2])
s['stall_count'] = int(sys.argv[3])
s['last_poll_at'] = int(sys.argv[4])
with open(sys.argv[5], 'w') as f:
    json.dump(s, f, indent=2)
" "$STATE_DIR/state.json" "$CURRENT_LINE_COUNT" "$NEW_STALL_COUNT" "$NOW" "$STATE_TMP"
  mv "$STATE_TMP" "$STATE_DIR/state.json"

  # --- Output ---
  echo "$POLL_OUTPUT"
  exit $EXIT_SUCCESS
fi

# ============================================================
# SUBCOMMAND: stop
# ============================================================
if [[ "${do_stop:-}" == 1 ]]; then

  STATE_DIR="${1:-}"
  if [[ -z "$STATE_DIR" ]]; then
    echo "Error: state directory argument required" >&2
    exit $EXIT_ERROR
  fi

  # Validate STATE_DIR: realpath + state.json + reconstruct from working_dir+run_id
  STATE_DIR_REAL=$(realpath "$STATE_DIR" 2>/dev/null || true)
  if [[ -z "$STATE_DIR_REAL" || ! -d "$STATE_DIR_REAL" ]]; then
    echo "Error: state directory does not exist" >&2
    exit $EXIT_ERROR
  fi
  STATE_DIR="$STATE_DIR_REAL"
  if [[ ! -f "$STATE_DIR/state.json" ]]; then
    echo "Error: no state.json found in $STATE_DIR — not a valid runner state" >&2
    exit $EXIT_ERROR
  fi

  # Reconstruct expected path from state.json and compare
  VALIDATE_RESULT=$(python3 -c "
import sys, json, os
with open(sys.argv[1]) as f:
    s = json.load(f)
wd = os.path.realpath(s.get('working_dir', ''))
rid = s.get('run_id', '')
expected = os.path.join(wd, '.codex-review', 'runs', rid)
actual = os.path.realpath(sys.argv[2])
print('OK' if expected == actual else 'MISMATCH')
" "$STATE_DIR/state.json" "$STATE_DIR" 2>/dev/null || echo "ERROR")

  if [[ "$VALIDATE_RESULT" == "MISMATCH" ]]; then
    # Fallback: check old /tmp format for migration
    if [[ "$STATE_DIR_REAL" =~ ^(/tmp|/private/tmp)/codex-runner-[0-9]+-[0-9]+$ ]]; then
      echo "[migration] Accepting legacy /tmp state directory" >&2
    else
      echo "Error: state directory path mismatch" >&2
      exit $EXIT_ERROR
    fi
  elif [[ "$VALIDATE_RESULT" != "OK" ]]; then
    echo "Error: state.json validation error" >&2
    exit $EXIT_ERROR
  fi

  if [[ -f "$STATE_DIR/state.json" ]]; then
    # Parse PID/PGID/watchdog
    STOP_VALS=$(python3 -c "
import sys, json
with open(sys.argv[1]) as f:
    s = json.load(f)
print(s.get('pid', ''))
print(s.get('pgid', ''))
print(s.get('watchdog_pid', ''))
" "$STATE_DIR/state.json" 2>/dev/null || true)

    CODEX_PID=$(echo "$STOP_VALS" | sed -n '1p')
    CODEX_PGID=$(echo "$STOP_VALS" | sed -n '2p')
    WATCHDOG_PID=$(echo "$STOP_VALS" | sed -n '3p')

    # Kill Codex process group (verify identity + PGID via ps to avoid PID reuse)
    if [[ -n "$CODEX_PID" && -n "$CODEX_PGID" ]] && kill -0 "$CODEX_PID" 2>/dev/null; then
      STOP_ARGS=$(ps -p "$CODEX_PID" -o args= 2>/dev/null || true)
      if [[ -z "$STOP_ARGS" ]]; then
        # ps unavailable — fallback to kill-by-existence
        kill -TERM -"$CODEX_PGID" 2>/dev/null || true
        sleep 1
        kill -KILL -"$CODEX_PGID" 2>/dev/null || true
      elif [[ "$STOP_ARGS" == *"codex exec"* ]]; then
        # Verify PGID matches before killing the group
        STOP_CURRENT_PGID=$(ps -p "$CODEX_PID" -o pgid= 2>/dev/null | tr -d ' ' || true)
        if [[ "$STOP_CURRENT_PGID" == "$CODEX_PGID" ]]; then
          kill -TERM -"$CODEX_PGID" 2>/dev/null || true
          sleep 1
          kill -KILL -"$CODEX_PGID" 2>/dev/null || true
        fi
      fi
    fi

    # Kill watchdog (verify identity)
    if [[ -n "$WATCHDOG_PID" ]] && kill -0 "$WATCHDOG_PID" 2>/dev/null; then
      STOP_WD_ARGS=$(ps -p "$WATCHDOG_PID" -o args= 2>/dev/null || true)
      if [[ -z "$STOP_WD_ARGS" || ( "$STOP_WD_ARGS" == *python* && "$STOP_WD_ARGS" == *"time.sleep"* ) ]]; then
        kill "$WATCHDOG_PID" 2>/dev/null || true
      fi
    fi
  fi

  # Remove state directory
  rm -rf "$STATE_DIR"
  exit $EXIT_SUCCESS
fi

# ============================================================
# LEGACY MODE (no subcommand — backwards compatible)
# ============================================================
if [[ "${do_legacy:-}" == 1 ]]; then

  # --- Defaults ---
  WORKING_DIR=""
  EFFORT="high"
  THREAD_ID=""
  TIMEOUT=3600
  POLL_INTERVAL=15

  # --- Parse arguments ---
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode) shift 2 ;;  # accepted but ignored for backwards compatibility
      --working-dir) WORKING_DIR="$2"; shift 2 ;;
      --effort) EFFORT="$2"; shift 2 ;;
      --thread-id) THREAD_ID="$2"; shift 2 ;;
      --timeout) TIMEOUT="$2"; shift 2 ;;
      --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
      --version) echo "codex-runner $CODEX_RUNNER_VERSION"; exit 0 ;;
      *) echo "Unknown option: $1" >&2; exit $EXIT_ERROR ;;
    esac
  done

  # --- Validate ---
  if [[ -z "$WORKING_DIR" ]]; then
    echo "Error: --working-dir is required" >&2
    exit $EXIT_ERROR
  fi
  if ! command -v codex &>/dev/null; then
    echo "Error: codex CLI not found in PATH" >&2
    exit $EXIT_CODEX_NOT_FOUND
  fi

  # --- Canonicalize WORKING_DIR ---
  WORKING_DIR_REAL=$(realpath "$WORKING_DIR")
  WORKING_DIR="$WORKING_DIR_REAL"

  # --- Read prompt from stdin ---
  PROMPT=$(cat)
  if [[ -z "$PROMPT" ]]; then
    echo "Error: no prompt provided on stdin" >&2
    exit $EXIT_ERROR
  fi

  # --- Temp files ---
  RUN_ID="$(date +%s)-$$"
  mkdir -p "${WORKING_DIR}/.codex-review/runs"
  JSONL_FILE="${WORKING_DIR}/.codex-review/runs/${RUN_ID}.jsonl"
  ERR_FILE="${WORKING_DIR}/.codex-review/runs/${RUN_ID}.err"

  cleanup() {
    local codex_pid_local="${CODEX_PID:-}"
    if [[ -n "$codex_pid_local" ]] && kill -0 "$codex_pid_local" 2>/dev/null; then
      kill "$codex_pid_local" 2>/dev/null || true
      wait "$codex_pid_local" 2>/dev/null || true
    fi
    rm -f "$JSONL_FILE" "$ERR_FILE"
  }
  trap cleanup EXIT

  # --- Build and launch Codex command ---
  CODEX_PID=""

  if [[ -n "$THREAD_ID" ]]; then
    cd "$WORKING_DIR"
    echo "$PROMPT" | codex exec --skip-git-repo-check --json resume "$THREAD_ID" \
      > "$JSONL_FILE" 2>"$ERR_FILE" &
    CODEX_PID=$!
  else
    echo "$PROMPT" | codex exec --skip-git-repo-check --json \
      --sandbox read-only \
      --config model_reasoning_effort="$EFFORT" \
      -C "$WORKING_DIR" \
      > "$JSONL_FILE" 2>"$ERR_FILE" &
    CODEX_PID=$!
  fi

  # --- Poll loop ---
  ELAPSED=0
  STALL_COUNT=0
  LAST_LINE_COUNT=0
  START_SECONDS=$SECONDS

  while true; do
    sleep "$POLL_INTERVAL"
    ELAPSED=$((SECONDS - START_SECONDS))

    if [[ $ELAPSED -ge $TIMEOUT ]]; then
      echo "[${ELAPSED}s] Error: timeout after ${TIMEOUT}s" >&2
      kill "$CODEX_PID" 2>/dev/null || true
      exit $EXIT_TIMEOUT
    fi

    if ! kill -0 "$CODEX_PID" 2>/dev/null; then
      wait "$CODEX_PID" 2>/dev/null || true
      CODEX_PID=""
      break
    fi

    if [[ -f "$JSONL_FILE" ]]; then
      CURRENT_LINE_COUNT=$(wc -l < "$JSONL_FILE" 2>/dev/null || echo 0)
      CURRENT_LINE_COUNT=$(echo "$CURRENT_LINE_COUNT" | tr -d ' ')
    else
      CURRENT_LINE_COUNT=0
    fi

    if [[ "$CURRENT_LINE_COUNT" -eq "$LAST_LINE_COUNT" ]]; then
      STALL_COUNT=$((STALL_COUNT + 1))
    else
      STALL_COUNT=0
      LAST_LINE_COUNT=$CURRENT_LINE_COUNT
    fi

    if [[ $STALL_COUNT -ge 12 ]]; then
      echo "[${ELAPSED}s] Error: stalled — no new output for ~3 minutes" >&2
      kill "$CODEX_PID" 2>/dev/null || true
      exit $EXIT_STALLED
    fi

    if [[ -f "$JSONL_FILE" ]]; then
      LAST_EVENT=$(tail -1 "$JSONL_FILE" 2>/dev/null || true)
      if [[ -n "$LAST_EVENT" ]]; then
        EVENT_TYPE=$(echo "$LAST_EVENT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('type',''))" 2>/dev/null || true)

        case "$EVENT_TYPE" in
          turn.completed)
            wait "$CODEX_PID" 2>/dev/null || true
            CODEX_PID=""
            break
            ;;
          turn.failed)
            ERROR_MSG=$(echo "$LAST_EVENT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','unknown error'))" 2>/dev/null || true)
            echo "[${ELAPSED}s] Error: Codex turn failed: $ERROR_MSG" >&2
            wait "$CODEX_PID" 2>/dev/null || true
            CODEX_PID=""
            exit $EXIT_TURN_FAILED
            ;;
          turn.started)
            echo "[${ELAPSED}s] Codex is thinking..." >&2
            ;;
          item.completed)
            ITEM_TYPE=$(echo "$LAST_EVENT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('item',{}).get('type',''))" 2>/dev/null || true)
            case "$ITEM_TYPE" in
              reasoning)
                REASONING_TEXT=$(echo "$LAST_EVENT" | python3 -c "import sys,json; t=json.loads(sys.stdin.read()).get('item',{}).get('text',''); print(t[:150]+'...' if len(t)>150 else t)" 2>/dev/null || true)
                echo "[${ELAPSED}s] Codex thinking: $REASONING_TEXT" >&2
                ;;
              command_execution)
                CMD=$(echo "$LAST_EVENT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('item',{}).get('command',''))" 2>/dev/null || true)
                echo "[${ELAPSED}s] Codex completed: $CMD" >&2
                ;;
              file_change)
                CHANGES_INFO=$(echo "$LAST_EVENT" | python3 -c "
import sys,json
item=json.loads(sys.stdin.read()).get('item',{})
for c in item.get('changes',[]):
    print(c.get('path','?')+' ('+c.get('kind','?')+')')
" 2>/dev/null || true)
                while IFS= read -r change_line; do
                  [[ -n "$change_line" ]] && echo "[${ELAPSED}s] Codex changed: $change_line" >&2
                done <<< "$CHANGES_INFO"
                ;;
            esac
            ;;
          item.started)
            ITEM_TYPE=$(echo "$LAST_EVENT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('item',{}).get('type',''))" 2>/dev/null || true)
            if [[ "$ITEM_TYPE" == "command_execution" ]]; then
              CMD=$(echo "$LAST_EVENT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('item',{}).get('command',''))" 2>/dev/null || true)
              echo "[${ELAPSED}s] Codex running: $CMD" >&2
            fi
            ;;
        esac
      fi
    fi
  done

  # --- Process exited: check for turn.completed ---
  if [[ ! -f "$JSONL_FILE" ]]; then
    echo "[${ELAPSED}s] Error: no JSONL output file found" >&2
    if [[ -f "$ERR_FILE" ]]; then
      cat "$ERR_FILE" >&2
    fi
    exit $EXIT_ERROR
  fi

  if grep -q '"type":"turn.failed"' "$JSONL_FILE" 2>/dev/null; then
    ERROR_MSG=$(grep '"type":"turn.failed"' "$JSONL_FILE" | tail -1 | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','unknown error'))" 2>/dev/null || true)
    echo "[${ELAPSED}s] Error: Codex turn failed: $ERROR_MSG" >&2
    exit $EXIT_TURN_FAILED
  fi

  if ! grep -q '"type":"turn.completed"' "$JSONL_FILE" 2>/dev/null; then
    echo "[${ELAPSED}s] Error: Codex process exited without turn.completed" >&2
    if [[ -f "$ERR_FILE" ]] && [[ -s "$ERR_FILE" ]]; then
      echo "[${ELAPSED}s] Stderr:" >&2
      cat "$ERR_FILE" >&2
    fi
    exit $EXIT_ERROR
  fi

  # --- Extract results ---
  # thread_id comes from thread.started events
  EXTRACTED_THREAD_ID=$(grep '"type":"thread.started"' "$JSONL_FILE" 2>/dev/null | head -1 | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('thread_id',''))" 2>/dev/null || true)
  # agent_message is nested inside item.completed events
  REVIEW_TEXT=$(grep '"agent_message"' "$JSONL_FILE" 2>/dev/null | tail -1 | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); item=d.get('item',{}); print(item.get('text','') if item.get('type')=='agent_message' else '')" 2>/dev/null || true)

  if [[ -z "$REVIEW_TEXT" ]]; then
    echo "[${ELAPSED}s] Error: no agent_message found in output" >&2
    exit $EXIT_ERROR
  fi

  if [[ -z "$EXTRACTED_THREAD_ID" ]]; then
    echo "[${ELAPSED}s] Error: no thread_id found in output" >&2
    exit $EXIT_ERROR
  fi

  # --- Output structured result ---
  REVIEW_JSON=$(THREAD_ID_VAL="$EXTRACTED_THREAD_ID" python3 -c "
import sys, json, os
text = sys.stdin.read()
print(json.dumps({'thread_id': os.environ.get('THREAD_ID_VAL', ''), 'review': text, 'status': 'success'}))
" <<< "$REVIEW_TEXT")

  echo "CODEX_RESULT:${REVIEW_JSON}"
  exit $EXIT_SUCCESS
fi

```

### Runner Output Format

**Start mode** outputs a single line:
```
CODEX_STARTED:<STATE_DIR>
```

**Poll mode** outputs on stdout (machine-readable, one line per field):
- Running: `POLL:running:<elapsed>s`
- Completed: `POLL:completed:<elapsed>s` + `THREAD_ID:<id>` (review text in `<STATE_DIR>/review.txt`)
- Failed: `POLL:failed:<elapsed>s:<exit_code>:<error>`
- Timeout: `POLL:timeout:<elapsed>s:2:<error>`
- Stalled: `POLL:stalled:<elapsed>s:4:<error>`

Progress events are written to stderr in format `[Xs] message` — these are visible in Bash tool output.

### Exit Codes (legacy mode)
- `0` = success
- `1` = general error
- `2` = timeout (3600s default)
- `3` = codex turn failed
- `4` = codex stalled (~3 min no output)
- `5` = codex not found in PATH

### Poll Status Codes
- `running` — Codex still working; stderr shows progress events
- `completed` — Codex finished; `THREAD_ID:<id>` on stdout, review in `<STATE_DIR>/review.txt`
- `failed` — Codex turn failed or process exited unexpectedly
- `timeout` — Exceeded timeout (default 3600s)
- `stalled` — No new output for ~3 minutes

## Step 1: Gather Configuration

Ask the user (via `AskUserQuestion`) **only one question**:
- Which reasoning effort to use (`xhigh`, `high`, `medium`, or `low`)

**Do NOT ask** which model to use — always use Codex's default model (no `-m` flag).
**Do NOT ask** how many rounds — the loop runs automatically until consensus.

## Step 2: Collect Uncommitted Changes

1. Run `git status --porcelain` to detect ALL changes including untracked (new) files.
2. If there are no changes at all, inform the user and stop.
3. **Detect if HEAD exists** — run `git rev-parse --verify HEAD 2>/dev/null`. If it fails (exit code non-zero), this is a fresh repo with no commits. Use `git diff --cached` and `git diff --cached --stat` (to capture staged changes) **plus** `git diff` and `git diff --stat` (to capture unstaged changes). If HEAD exists, use `git diff HEAD` and `git diff --stat HEAD` as normal (which covers both staged and unstaged).
4. **Stage untracked files for diffing** — if there are untracked files (`??` in porcelain output), run `git add -N <file>` (intent-to-add) for each one so they appear in git diff. This does NOT actually stage the files for commit — it only makes them visible to diff.
5. Run the appropriate `git diff --stat` command (with or without `HEAD` per step 3) to get a summary of all changed files.
6. If the number of changed files is very large, ask the user which files to focus on, or split into multiple review sessions.
7. **Extract the plan from conversation** — look back through the conversation history for the implementation plan that guided these changes. This could be a plan from plan mode, a plan discussed with the user, or task instructions. Summarize the plan into a concise text block that you will embed directly in the Codex prompt. If no plan exists in the conversation, proceed without it (but having one significantly improves review quality).

## Prompt Construction Principle

**Only include in the Codex prompt what Codex cannot access on its own:**
- The implementation plan (extracted from the conversation and embedded directly in the prompt, so Codex can cross-reference the implementation intent)
- The user's original request / task description
- Important context from the conversation: user comments, constraints, preferences, architectural decisions discussed verbally
- Clarifications or special instructions the user gave
- Which specific files to focus on (if the user specified)

**Do NOT include:**
- The diff content (Codex runs `git diff HEAD` itself)
- Code snippets Codex can read from the repo
- Information Codex can derive by reading files

## Step 3: Send Changes to Codex for Review (Round 1)

### Step 3a — Start Codex

Run the codex-runner `start` subcommand with the bootstrap block:

```bash
RUNNER="${CODEX_RUNNER:-$HOME/.local/bin/codex-runner.sh}"
NEED_INSTALL=0
if [ -n "$CODEX_RUNNER" ] && test -x "$CODEX_RUNNER"; then
  if ! grep -q 'CODEX_RUNNER_VERSION="5"' "$CODEX_RUNNER" 2>/dev/null; then NEED_INSTALL=1; fi
elif ! test -x "$RUNNER"; then NEED_INSTALL=1
elif ! grep -q 'CODEX_RUNNER_VERSION="5"' "$RUNNER" 2>/dev/null; then NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  TMP=$(mktemp "$HOME/.local/bin/codex-runner.XXXXXX")
  cat > "$TMP" <<'RUNNER_SCRIPT'
<PASTE FULL SCRIPT FROM ABOVE>
RUNNER_SCRIPT
  chmod +x "$TMP"
  mv "$TMP" "$HOME/.local/bin/codex-runner.sh"
  RUNNER="$HOME/.local/bin/codex-runner.sh"
fi
"$RUNNER" start --working-dir <WORKING_DIR> --effort <EFFORT> <<'EOF'
<REVIEW_PROMPT>
EOF
```

The output will be: `CODEX_STARTED:<WORKING_DIR>/.codex-review/runs/<RUN_ID>`

Save the state directory path — you need it for polling and cleanup.

### Step 3b — Poll Loop

Call `poll` repeatedly to check progress. Each poll outputs status on stdout and progress on stderr:

```bash
sleep 60 && "$RUNNER" poll <STATE_DIR>
```

After each poll:
- stdout starts with `POLL:running:` → Codex is still working. The stderr output shows progress events like `[45s] Codex running: git diff HEAD`. Call poll again — use `sleep 30` for the second poll, then `sleep 15` for all subsequent polls.
- stdout starts with `POLL:completed:` → Extract thread_id from the `THREAD_ID:` line. Read the review from `<STATE_DIR>/review.txt` using the Read tool. Proceed to Step 3c.
- stdout starts with `POLL:failed:` or `POLL:timeout:` or `POLL:stalled:` → Handle per Error Handling section. Call `stop` to cleanup.

**Progress reporting**: The stderr output from the Bash tool call shows progress events (e.g., `[45s] Codex is thinking...`, `[52s] Codex running: git diff HEAD`). Summarize these for the user between polls.

### Step 3c — Cleanup

After extracting the completed result (or handling an error):

```bash
"$RUNNER" stop <STATE_DIR>
```

This kills any remaining processes and removes the state directory.

Save the `thread_id` from the `THREAD_ID:` line — you will need it for subsequent rounds.

### Review Prompt Template

```
You are participating in a code review with Claude Code (Claude Opus 4.6).

## Your Role
You are the CODE REVIEWER. You review ONLY — you do NOT modify any code. Your job is to inspect uncommitted changes and report bugs, missing edge cases, error handling gaps, security vulnerabilities, and code quality issues. Be thorough, specific, and constructive. Claude Code will handle all fixes based on your feedback.

## How to Inspect Changes
1. Run `git status --porcelain` to see all changes including untracked files.
2. Check if HEAD exists: `git rev-parse --verify HEAD 2>/dev/null`. If it fails, use `git diff --cached --stat` and `git diff --cached` (for staged changes) plus `git diff --stat` and `git diff` (for unstaged changes). If it succeeds, use `git diff --stat HEAD` and `git diff HEAD`.
3. Run the appropriate git diff command to see the full diff. (Note: untracked files have already been marked with `git add -N` so they appear in the diff.)
4. Read any relevant source files for additional context if needed.

## Implementation Plan
<PLAN_CONTENT_FROM_CONVERSATION>
(If no plan exists in the conversation, write: "No implementation plan available — review the diff based on code quality alone.")

## User's Original Request
<The user's original task/request>

## Session Context
<Any important context from the conversation that Codex cannot access on its own>

(If there is no additional context, write "No additional context.")

## Instructions
1. Read the diff using the git commands above.
2. Read the implementation plan provided above and cross-reference: does the implementation match the plan? Are there deviations?
3. Analyze every changed file and produce your review in the EXACT format below.

## Required Output Format

For each issue found, use this structure:

### ISSUE-{N}: {Short title}
- **Category**: Bug | Edge Case | Error Handling | Security | Code Quality | Plan Deviation
- **Severity**: CRITICAL | HIGH | MEDIUM | LOW
- **File**: `{file_path}:{line_number or line_range}`
- **Description**: What the problem is, in detail.
- **Why It Matters**: Concrete scenario or example showing how this causes a real failure.
- **Suggested Fix**: Specific code change or approach to fix this. (Required for CRITICAL and HIGH severity. Recommended for others.)

After all issues, provide:

### VERDICT
- **Result**: REJECT | APPROVE_WITH_CHANGES | APPROVE
- **Summary**: 2-3 sentence overall assessment.
- **Plan Alignment**: Does the implementation correctly follow the plan? Note any deviations. (Skip if no plan was provided.)

Rules:
- Reference exact files and line numbers/hunks in the diff.
- Explain WHY each issue is a problem with a concrete scenario.
- Do NOT rubber-stamp the code. Your value comes from finding real problems.
- Do NOT nitpick style or formatting unless it causes actual issues.
- Do NOT attempt to fix or modify any files. Report issues only.
- Every CRITICAL or HIGH severity issue MUST have a Suggested Fix.
```

**After receiving Codex's review**, summarize the findings for the user, grouped by severity.

## Step 4: Claude Code Responds (Round 1)

After receiving Codex's review, you (Claude Code) must:

1. **Analyze each ISSUE-{N}** against the actual code.
2. **Fix valid issues** - If Codex found real bugs, edge cases, or security issues:
   - Apply the fixes directly to the code files using Edit tool.
   - Keep fixes minimal and focused — don't refactor surrounding code.
3. **Push back on invalid points** - If Codex flagged something incorrectly:
   - Explain why it's not actually a problem (e.g., the edge case is handled upstream, the framework guarantees safety, etc.)
   - Use evidence: read the relevant code, check documentation, web search if needed.
4. **Summarize for the user**: What you fixed, what you disputed, and why.
5. **Immediately proceed to Step 5** — do NOT ask the user whether to continue. Always send the updated code back to Codex for re-review.

## Step 5: Continue the Debate (Rounds 2+)

### Step 5a — Start Codex (resume)

Run the runner with `--thread-id` to resume the existing Codex conversation:

```bash
RUNNER="${CODEX_RUNNER:-$HOME/.local/bin/codex-runner.sh}"
NEED_INSTALL=0
if [ -n "$CODEX_RUNNER" ] && test -x "$CODEX_RUNNER"; then
  if ! grep -q 'CODEX_RUNNER_VERSION="5"' "$CODEX_RUNNER" 2>/dev/null; then NEED_INSTALL=1; fi
elif ! test -x "$RUNNER"; then NEED_INSTALL=1
elif ! grep -q 'CODEX_RUNNER_VERSION="5"' "$RUNNER" 2>/dev/null; then NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  TMP=$(mktemp "$HOME/.local/bin/codex-runner.XXXXXX")
  cat > "$TMP" <<'RUNNER_SCRIPT'
<PASTE FULL SCRIPT FROM ABOVE>
RUNNER_SCRIPT
  chmod +x "$TMP"
  mv "$TMP" "$HOME/.local/bin/codex-runner.sh"
  RUNNER="$HOME/.local/bin/codex-runner.sh"
fi
"$RUNNER" start --working-dir <WORKING_DIR> --effort <EFFORT> --thread-id <THREAD_ID> <<'EOF'
<REBUTTAL_PROMPT>
EOF
```

### Step 5b — Poll Loop

Same as Step 3b — poll until completed, then proceed to Step 5c.

### Step 5c — Cleanup

```bash
"$RUNNER" stop <STATE_DIR>
```

### Rebuttal Prompt Template

```
This is Claude Code (Claude Opus 4.6) responding to your review. I have applied fixes and want you to re-review.

## Issues Fixed
<For each fixed issue, reference by ISSUE-{N} and describe the specific change made>

## Issues Disputed
<For each disputed issue, reference by ISSUE-{N} and explain why with evidence>

## Your Turn
Run `git diff HEAD` again to see the updated changes (or `git diff --cached` plus `git diff` if this is a fresh repo with no commits), then re-review.
- Have your previous concerns been properly addressed?
- Do the fixes introduce any NEW issues?
- Are there any remaining problems you still see?

Use the same output format as before (ISSUE-{N} structure + VERDICT).
Verdict options: REJECT | APPROVE_WITH_CHANGES | APPROVE
```

**After each Codex response:**
1. Summarize Codex's response for the user.
2. If verdict is `APPROVE` → proceed to Step 6.
3. If verdict is `APPROVE_WITH_CHANGES` → evaluate suggestions, apply if valid, then **automatically** send one more round to Codex for confirmation. Do NOT ask the user.
4. If verdict is `REJECT` → fix remaining issues and **automatically** continue to next round. Do NOT ask the user.

**IMPORTANT**: The debate loop is fully automatic. After fixing issues, ALWAYS send the updated code back to Codex without asking the user. The loop only stops when Codex returns `APPROVE`. The user is only consulted at the very end (Step 6) or if a stalemate is detected.

### Early Termination & Round Extension

- **Early termination**: If Codex returns `APPROVE`, end the debate immediately and proceed to Step 6.
- **Round extension**: There is no hard round limit. Continue the fix → re-review loop until either:
  - Codex returns `APPROVE`, OR
  - The same points go back and forth without progress for 2 consecutive rounds (stalemate detected) → present the disagreement to the user and let them decide.

**Repeat** Steps 4-5 until consensus or stalemate.

## Step 6: Finalize and Report

Present the user with a **Code Review Debate Summary**:

```
## Code Review Debate Summary

### Rounds: X
### Final Verdict: [CONSENSUS REACHED / STALEMATE - USER DECISION NEEDED]

### Bugs Fixed:
1. [Bug description - file:line]
...

### Edge Cases Added:
1. [Edge case - file:line]
...

### Error Handling Improved:
1. [What was added - file:line]
...

### Security Issues Resolved:
1. [Issue - file:line]
...

### Plan Deviations Found:
1. [Deviation - context]
...

### Disputed Points (Claude's position maintained):
1. [Point - reasoning]
...

### Remaining Concerns (if stalemate):
1. [Unresolved issue - context]
...
```

Then ask the user (via `AskUserQuestion`):
- **Accept & Commit** - Code is ready, user can commit
- **Request more rounds** - Continue debating specific concerns
- **Review changes manually** - User wants to inspect the fixes themselves before deciding

## Important Rules

1. **Codex reads the diff itself** - Do NOT paste diff content into the prompt. Just instruct Codex to run `git diff`.
2. **Embed the plan directly in the prompt** - Extract the plan from the conversation and include it inline in the Codex prompt. Do NOT reference external plan files.
3. **Only send what Codex can't access** - The prompt should contain: the plan (from conversation), user's original request, session context. NOT: diffs, file contents, code snippets.
4. **Always `git add -N` untracked files first** - So new files appear in `git diff`.
5. **Always use heredoc (`<<'EOF'`) for prompts** - Heredoc with single-quoted delimiter prevents shell expansion.
6. **No `-m` flag** - Always use Codex's default model.
7. **Resume by thread ID** - Use the `thread_id` from the `THREAD_ID:` line of poll completed output for subsequent rounds.
8. **Handle repos with no HEAD** - Before running `git diff HEAD`, check `git rev-parse --verify HEAD`. If HEAD doesn't exist, use `git diff --cached` + `git diff` instead.
9. **Claude Code does all the fixing** - Codex identifies issues, Claude Code applies fixes.
10. **Be genuinely adversarial** - Don't blindly accept all of Codex's findings. Push back with evidence when Codex is wrong.
11. **Don't over-fix** - Only fix what's actually broken or risky. Don't add defensive code for impossible scenarios.
12. **Summarize after every round** - The user should always know what happened before the next round begins.
13. **Respect the diff boundary** - Only review and fix code within the uncommitted changes.
14. **Require structured output** - If Codex's response doesn't follow the ISSUE-{N} format, ask it to reformat in the resume prompt.
15. **Always call `stop` after getting results** - Clean up the state directory after extracting the completed result or handling errors.

## Error Handling

- If `git status --porcelain` shows no changes, inform the user and stop.
- If `git rev-parse --verify HEAD` fails, use `git diff --cached` + `git diff` instead of `git diff HEAD`.
- If poll returns `POLL:timeout:`, inform the user and ask if they want to retry. Call `stop` to cleanup.
- If poll returns `POLL:failed:`, report the error message to the user. Call `stop` to cleanup.
- If poll returns `POLL:stalled:`, ask the user whether to retry or abort. Call `stop` to cleanup.
- If the `start` command exits with code `5` (codex not found), tell the user to install the Codex CLI.
- If the diff is too large for a single prompt, suggest splitting by file or directory.
- If the debate stalls on a point, present both positions to the user and let them decide.
