---
name: codex-plan-review
description: Debate implementation plans between Claude Code and Codex CLI. After Claude Code creates a plan, invoke this skill to have Codex review it. Both AIs debate through multiple rounds until reaching full consensus before implementation begins. This skill CAN and SHOULD be invoked while still in plan mode — do NOT exit plan mode before calling this skill.
---

# Codex Plan Review — Skill Guide

## Overview
This skill orchestrates an adversarial debate between Claude Code and OpenAI Codex CLI to stress-test implementation plans. The goal is to catch flaws, blind spots, and improvements **before** any code is written.

**Flow:** Claude Code's plan → Codex reviews → Claude Code rebuts → Codex rebuts → ... → Consensus → Implement

## Prerequisites

> **Plan Mode Compatible:** This skill works fully within plan mode. Do NOT exit plan mode before invoking this skill. The debate should complete while still in plan mode, so the consensus result can inform the final plan before implementation begins.

- You (Claude Code) must already have a plan ready. If no plan exists yet, ask the user to create one first (e.g., via plan mode or `/plan`).
- The plan must be saved to a file that Codex can read (e.g., `plan.md`, `.claude/plan.md`, or the plan mode output file).
- The Codex CLI (`codex`) must be installed and available in PATH.

## Codex Runner Script

This skill uses `codex-runner.py` with `start`/`poll`/`stop` subcommands to run Codex CLI in the background and report progress incrementally. The runner is a single cross-platform Python script (no bash dependency).

- **`start`** � launches Codex as a detached background process, returns immediately with a state directory path
- **`poll`** � checks progress, outputs plain text status on stdout and progress events on stderr
- **`stop`** � kills processes and cleans up the state directory

### Bootstrap Logic (inline in every Bash call)

Every Bash call that invokes the runner must include this resolve block at the top:

```bash
PY=""
for cmd in python3 python py; do
  if command -v "$cmd" >/dev/null 2>&1; then PY="$cmd"; break; fi
done
[ -z "$PY" ] && { echo "Error: Python 3 not found" >&2; exit 1; }
RUNNER="${CODEX_RUNNER:-$HOME/.local/bin/codex-runner.py}"
NEED_INSTALL=0
if [ -n "$CODEX_RUNNER" ] && [ -f "$CODEX_RUNNER" ]; then
  if ! "$PY" "$CODEX_RUNNER" version 2>/dev/null | grep -q "^7$"; then NEED_INSTALL=1; fi
elif [ ! -f "$RUNNER" ]; then NEED_INSTALL=1
elif ! "$PY" "$RUNNER" version 2>/dev/null | grep -q "^7$"; then NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$RUNNER" <<'RUNNER_SCRIPT'
<EMBEDDED_SCRIPT_CONTENT>
RUNNER_SCRIPT
fi
```

Where `<EMBEDDED_SCRIPT_CONTENT>` is the full content of the codex-runner.py script below:

```python
"""codex-runner.py — Cross-platform runner for Codex CLI (stdlib only).

Replaces codex-runner.sh + codex-proc-helper.py in a single file.
Subcommands: start, poll, stop, version
"""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

# --- Constants ---
CODEX_RUNNER_VERSION = 7

EXIT_SUCCESS = 0
EXIT_ERROR = 1
EXIT_TIMEOUT = 2
EXIT_TURN_FAILED = 3
EXIT_STALLED = 4
EXIT_CODEX_NOT_FOUND = 5

IS_WIN = sys.platform == "win32"

# ============================================================
# Process management
# ============================================================

def launch_codex(state_dir, working_dir, timeout_s, thread_id, effort):
    """Launch codex exec as a detached background process. Returns (pid, pgid)."""
    prompt_file = os.path.join(state_dir, "prompt.txt")
    jsonl_file = os.path.join(state_dir, "output.jsonl")
    err_file = os.path.join(state_dir, "error.log")

    if thread_id:
        cmd = ["codex", "exec", "--skip-git-repo-check", "--json", "resume", thread_id]
        cwd = working_dir
    else:
        cmd = [
            "codex", "exec", "--skip-git-repo-check", "--json",
            "--sandbox", "read-only",
            "--config", "model_reasoning_effort=" + effort,
            "-C", working_dir,
        ]
        cwd = None

    kwargs = dict(cwd=cwd)
    if IS_WIN:
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        kwargs["creationflags"] = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True

    fin = open(prompt_file, "r")
    fout = open(jsonl_file, "w")
    ferr = open(err_file, "w")
    kwargs.update(stdin=fin, stdout=fout, stderr=ferr)

    p = subprocess.Popen(cmd, **kwargs)

    # Close file handles in parent — child owns them now
    fin.close()
    fout.close()
    ferr.close()

    return p.pid, p.pid  # pgid == pid for both platforms


def is_alive(pid):
    """Check if a process is alive."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def kill_tree(pid):
    """Kill a process and all its children."""
    try:
        if IS_WIN:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            os.killpg(pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass


def kill_single(pid):
    """Kill a single process."""
    try:
        if IS_WIN:
            subprocess.run(
                ["taskkill", "/F", "/PID", str(pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            os.kill(pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass


def get_cmdline(pid):
    """Get process command line. Returns string or None."""
    try:
        if IS_WIN:
            try:
                result = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     f"(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine"],
                    capture_output=True, text=True, timeout=10,
                )
                cmdline = result.stdout.strip()
                if cmdline:
                    return cmdline
            except FileNotFoundError:
                pass
            try:
                result = subprocess.run(
                    ["wmic", "process", "where", f"ProcessId={pid}",
                     "get", "CommandLine", "/value"],
                    capture_output=True, text=True, timeout=5,
                )
                for line in result.stdout.splitlines():
                    if line.startswith("CommandLine="):
                        return line[len("CommandLine="):]
            except FileNotFoundError:
                pass
            return None
        else:
            result = subprocess.run(
                ["ps", "-p", str(pid), "-o", "args="],
                capture_output=True, text=True, timeout=5,
            )
            return result.stdout.strip() if result.returncode == 0 else None
    except Exception:
        return None


def verify_codex(pid):
    """Verify a PID belongs to a codex process. Returns: verified/dead/unknown/mismatch."""
    if not is_alive(pid):
        return "dead"
    cmdline = get_cmdline(pid)
    if cmdline is None:
        return "unknown"
    if "codex exec" in cmdline or "codex.exe exec" in cmdline:
        return "verified"
    return "mismatch"


def verify_watchdog(pid):
    """Verify a PID belongs to our watchdog. Returns: verified/dead/unknown/mismatch."""
    if not is_alive(pid):
        return "dead"
    cmdline = get_cmdline(pid)
    if cmdline is None:
        return "unknown"
    if "python" in cmdline.lower() and ("time.sleep" in cmdline or "codex-runner" in cmdline):
        return "verified"
    return "mismatch"


def launch_watchdog(timeout_s, target_pid):
    """Launch a watchdog subprocess that kills target_pid after timeout_s seconds."""
    # The watchdog runs: python codex-runner.py _watchdog <timeout> <pid>
    script = os.path.abspath(__file__)
    py = sys.executable
    cmd = [py, script, "_watchdog", str(timeout_s), str(target_pid)]

    kwargs = {}
    if IS_WIN:
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        kwargs["creationflags"] = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True

    p = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **kwargs,
    )
    return p.pid


# ============================================================
# File I/O
# ============================================================

def atomic_write(filepath, content):
    """Write content to filepath atomically using os.replace()."""
    dirpath = os.path.dirname(filepath)
    fd, tmp_path = tempfile.mkstemp(dir=dirpath, prefix=os.path.basename(filepath) + ".")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp_path, filepath)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def read_state(state_dir):
    """Read and return parsed state.json from state_dir."""
    state_file = os.path.join(state_dir, "state.json")
    with open(state_file) as f:
        return json.load(f)


def update_state(state_dir, updates):
    """Read state.json, apply updates dict, write back atomically."""
    state = read_state(state_dir)
    state.update(updates)
    atomic_write(
        os.path.join(state_dir, "state.json"),
        json.dumps(state, indent=2),
    )
    return state


# ============================================================
# JSONL parsing
# ============================================================

def parse_jsonl(state_dir, last_line_count, elapsed, process_alive, timeout_val):
    """Parse JSONL output and return (stdout_output, stderr_lines).

    stdout_output: the POLL status lines to print to stdout
    stderr_lines: progress messages to print to stderr
    """
    jsonl_file = os.path.join(state_dir, "output.jsonl")
    err_file = os.path.join(state_dir, "error.log")

    all_lines = []
    if os.path.isfile(jsonl_file):
        with open(jsonl_file) as f:
            all_lines = f.readlines()

    turn_completed = False
    turn_failed = False
    turn_failed_msg = ""
    extracted_thread_id = ""
    review_text = ""

    # Parse ALL lines for terminal state + data extraction
    for line in all_lines:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        t = d.get("type", "")

        if t == "thread.started" and d.get("thread_id"):
            extracted_thread_id = d["thread_id"]

        if t == "turn.completed":
            turn_completed = True
        elif t == "turn.failed":
            turn_failed = True
            turn_failed_msg = d.get("error", {}).get("message", "unknown error")

        if t == "item.completed":
            item = d.get("item", {})
            if item.get("type") == "agent_message":
                review_text = item.get("text", "")

    # Parse NEW lines for progress events
    stderr_lines = []
    new_lines = all_lines[last_line_count:]
    for line in new_lines:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        t = d.get("type", "")
        item = d.get("item", {})
        item_type = item.get("type", "")

        if t == "turn.started":
            stderr_lines.append(f"[{elapsed}s] Codex is thinking...")
        elif t == "item.completed" and item_type == "reasoning":
            text = item.get("text", "")
            if len(text) > 150:
                text = text[:150] + "..."
            stderr_lines.append(f"[{elapsed}s] Codex thinking: {text}")
        elif t == "item.started" and item_type == "command_execution":
            cmd = item.get("command", "")
            stderr_lines.append(f"[{elapsed}s] Codex running: {cmd}")
        elif t == "item.completed" and item_type == "command_execution":
            cmd = item.get("command", "")
            stderr_lines.append(f"[{elapsed}s] Codex completed: {cmd}")
        elif t == "item.completed" and item_type == "file_change":
            for c in item.get("changes", []):
                path = c.get("path", "?")
                kind = c.get("kind", "?")
                stderr_lines.append(f"[{elapsed}s] Codex changed: {path} ({kind})")

    def sanitize_msg(s):
        if s is None:
            return "unknown error"
        return re.sub(r"\s+", " ", str(s)).strip()

    # Determine status
    stdout_parts = []
    if turn_completed:
        if not extracted_thread_id or not review_text:
            error_detail = "no thread_id" if not extracted_thread_id else "no agent_message"
            stdout_parts.append(f"POLL:failed:{elapsed}s:1:turn.completed but {error_detail}")
        else:
            review_path = os.path.join(state_dir, "review.txt")
            with open(review_path, "w") as f:
                f.write(review_text)
            stdout_parts.append(f"POLL:completed:{elapsed}s")
            stdout_parts.append(f"THREAD_ID:{extracted_thread_id}")
    elif turn_failed:
        stdout_parts.append(f"POLL:failed:{elapsed}s:3:Codex turn failed: {sanitize_msg(turn_failed_msg)}")
    elif not process_alive:
        if timeout_val > 0 and elapsed >= timeout_val:
            stdout_parts.append(f"POLL:timeout:{elapsed}s:2:Timeout after {timeout_val}s")
        else:
            err_content = ""
            if os.path.isfile(err_file):
                with open(err_file) as f:
                    err_content = f.read().strip()
            error_msg = "Codex process exited unexpectedly"
            if err_content:
                error_msg += ": " + sanitize_msg(err_content[:200])
            stdout_parts.append(f"POLL:failed:{elapsed}s:1:{error_msg}")
    else:
        stdout_parts.append(f"POLL:running:{elapsed}s")

    return "\n".join(stdout_parts), stderr_lines


# ============================================================
# Validation helpers
# ============================================================

def validate_state_dir(state_dir):
    """Validate that state_dir is a valid runner state directory. Returns resolved path or exits."""
    state_dir = os.path.realpath(state_dir)
    if not os.path.isdir(state_dir):
        return None, "Invalid or missing state directory"
    state_file = os.path.join(state_dir, "state.json")
    if not os.path.isfile(state_file):
        return None, "state.json not found"

    # Reconstruct expected path from state.json and compare
    try:
        with open(state_file) as f:
            s = json.load(f)
        wd = os.path.realpath(s.get("working_dir", ""))
        rid = s.get("run_id", "")
        expected = os.path.join(wd, ".codex-review", "runs", rid)
        actual = os.path.realpath(state_dir)
        if expected != actual:
            return None, "state directory path mismatch"
    except Exception:
        return None, "state.json validation error"

    return state_dir, None


def verify_and_kill_codex(pid, pgid):
    """Verify PID belongs to codex, then kill tree if safe."""
    status = verify_codex(pid)
    if status in ("verified", "unknown"):
        kill_tree(pgid)


def verify_and_kill_watchdog(pid):
    """Verify PID belongs to watchdog, then kill if safe."""
    status = verify_watchdog(pid)
    if status in ("verified", "unknown"):
        kill_single(pid)


# ============================================================
# Subcommands
# ============================================================

def cmd_start(args):
    """Start a new Codex run."""
    working_dir = args.working_dir
    effort = args.effort
    thread_id = args.thread_id or ""
    timeout = args.timeout

    if not working_dir:
        print("Error: --working-dir is required", file=sys.stderr)
        return EXIT_ERROR

    if not shutil.which("codex"):
        print("Error: codex CLI not found in PATH", file=sys.stderr)
        return EXIT_CODEX_NOT_FOUND

    working_dir = os.path.realpath(working_dir)

    # Read prompt from stdin
    prompt = sys.stdin.read()
    if not prompt.strip():
        print("Error: no prompt provided on stdin", file=sys.stderr)
        return EXIT_ERROR

    # Create state directory
    run_id = f"{int(time.time())}-{os.getpid()}"
    state_dir = os.path.join(working_dir, ".codex-review", "runs", run_id)
    os.makedirs(state_dir, exist_ok=True)

    # Write prompt
    with open(os.path.join(state_dir, "prompt.txt"), "w") as f:
        f.write(prompt)

    # Startup rollback: track what to clean up
    codex_pgid = None
    watchdog_pid = None

    def startup_cleanup():
        if codex_pgid is not None:
            kill_tree(codex_pgid)
        if watchdog_pid is not None and is_alive(watchdog_pid):
            kill_single(watchdog_pid)
        shutil.rmtree(state_dir, ignore_errors=True)

    try:
        # Launch Codex
        codex_pid, codex_pgid = launch_codex(state_dir, working_dir, timeout, thread_id, effort)

        # Launch watchdog
        watchdog_pid = launch_watchdog(timeout, codex_pgid)

        # Verify process is alive
        time.sleep(1)
        if not is_alive(codex_pid):
            print("Error: Codex process died immediately after launch", file=sys.stderr)
            startup_cleanup()
            return EXIT_ERROR

        # Write state.json atomically
        now = int(time.time())
        state = {
            "pid": codex_pid,
            "pgid": codex_pgid,
            "watchdog_pid": watchdog_pid,
            "run_id": run_id,
            "state_dir": state_dir,
            "working_dir": working_dir,
            "effort": effort,
            "timeout": timeout,
            "started_at": now,
            "thread_id": thread_id,
            "last_line_count": 0,
            "stall_count": 0,
            "last_poll_at": 0,
        }
        atomic_write(os.path.join(state_dir, "state.json"), json.dumps(state, indent=2))

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        startup_cleanup()
        return EXIT_ERROR

    # Success
    print(f"CODEX_STARTED:{state_dir}")
    return EXIT_SUCCESS


def cmd_poll(args):
    """Poll a running Codex process for status."""
    if not args.state_dir:
        print("POLL:failed:0s:1:Invalid or missing state directory")
        return EXIT_ERROR

    state_dir, err = validate_state_dir(args.state_dir)
    if err:
        print(f"POLL:failed:0s:1:{err}")
        return EXIT_ERROR

    # Check for cached final result
    final_file = os.path.join(state_dir, "final.txt")
    if os.path.isfile(final_file):
        with open(final_file) as f:
            print(f.read(), end="")
        review_file = os.path.join(state_dir, "review.txt")
        if os.path.isfile(review_file):
            print(f"[cached] Review available in {state_dir}/review.txt", file=sys.stderr)
        return EXIT_SUCCESS

    # Read state
    state = read_state(state_dir)
    codex_pid = state.get("pid", 0)
    codex_pgid = state.get("pgid", 0)
    watchdog_pid = state.get("watchdog_pid", 0)
    timeout_val = state.get("timeout", 3600)
    started_at = state.get("started_at", int(time.time()))
    last_line_count = state.get("last_line_count", 0)
    stall_count = state.get("stall_count", 0)

    now = int(time.time())
    elapsed = now - started_at

    # Check if process is alive
    process_alive = is_alive(codex_pid)

    # Count lines
    jsonl_file = os.path.join(state_dir, "output.jsonl")
    current_line_count = 0
    if os.path.isfile(jsonl_file):
        with open(jsonl_file) as f:
            current_line_count = sum(1 for _ in f)

    # Stall detection
    if current_line_count == last_line_count:
        new_stall_count = stall_count + 1
    else:
        new_stall_count = 0

    # Parse JSONL
    poll_output, stderr_lines = parse_jsonl(
        state_dir, last_line_count, elapsed, process_alive, timeout_val,
    )

    # Print progress to stderr
    for line in stderr_lines:
        print(line, file=sys.stderr)

    # Determine poll status from first line
    poll_status = ""
    first_line = poll_output.split("\n")[0] if poll_output else ""
    parts = first_line.split(":")
    if len(parts) >= 2:
        poll_status = parts[1]

    def write_final_and_cleanup(content):
        atomic_write(os.path.join(state_dir, "final.txt"), content)
        verify_and_kill_codex(codex_pid, codex_pgid)
        if watchdog_pid:
            verify_and_kill_watchdog(watchdog_pid)

    if poll_status != "running":
        write_final_and_cleanup(poll_output)
    else:
        # Check timeout/stall only when still running
        if elapsed >= timeout_val:
            poll_output = f"POLL:timeout:{elapsed}s:{EXIT_TIMEOUT}:Timeout after {timeout_val}s"
            write_final_and_cleanup(poll_output)
        elif new_stall_count >= 12 and process_alive:
            poll_output = f"POLL:stalled:{elapsed}s:{EXIT_STALLED}:No new output for ~3 minutes"
            write_final_and_cleanup(poll_output)

    # Update state.json
    update_state(state_dir, {
        "last_line_count": current_line_count,
        "stall_count": new_stall_count,
        "last_poll_at": now,
    })

    print(poll_output)
    return EXIT_SUCCESS


def cmd_stop(args):
    """Stop a running Codex process and clean up."""
    if not args.state_dir:
        print("Error: state directory argument required", file=sys.stderr)
        return EXIT_ERROR

    state_dir, err = validate_state_dir(args.state_dir)
    if err:
        print(f"Error: {err}", file=sys.stderr)
        return EXIT_ERROR

    # Read state and kill processes
    try:
        state = read_state(state_dir)
        codex_pid = state.get("pid", 0)
        codex_pgid = state.get("pgid", 0)
        watchdog_pid = state.get("watchdog_pid", 0)

        if codex_pid and codex_pgid:
            verify_and_kill_codex(codex_pid, codex_pgid)
        if watchdog_pid:
            verify_and_kill_watchdog(watchdog_pid)
    except Exception:
        pass

    # Remove state directory
    shutil.rmtree(state_dir, ignore_errors=True)
    return EXIT_SUCCESS


def cmd_watchdog(args):
    """Internal: watchdog that kills target after timeout. Not for direct use."""
    timeout_s = int(args.timeout)
    target_pid = int(args.target_pid)

    if not IS_WIN:
        try:
            os.setsid()
        except OSError:
            pass

    time.sleep(timeout_s)
    kill_tree(target_pid)
    return EXIT_SUCCESS


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="codex-runner: Cross-platform runner for Codex CLI",
    )
    sub = parser.add_subparsers(dest="command")

    # version
    sub.add_parser("version", help="Print version number")

    # start
    p_start = sub.add_parser("start", help="Start a new Codex run")
    p_start.add_argument("--working-dir", required=True)
    p_start.add_argument("--effort", default="high")
    p_start.add_argument("--thread-id", default="")
    p_start.add_argument("--timeout", type=int, default=3600)

    # poll
    p_poll = sub.add_parser("poll", help="Poll a running Codex process")
    p_poll.add_argument("state_dir")

    # stop
    p_stop = sub.add_parser("stop", help="Stop a running Codex process")
    p_stop.add_argument("state_dir")

    # _watchdog (internal)
    p_wd = sub.add_parser("_watchdog", help=argparse.SUPPRESS)
    p_wd.add_argument("timeout")
    p_wd.add_argument("target_pid")

    args = parser.parse_args()

    if args.command == "version":
        print(CODEX_RUNNER_VERSION)
        return EXIT_SUCCESS
    elif args.command == "start":
        return cmd_start(args)
    elif args.command == "poll":
        return cmd_poll(args)
    elif args.command == "stop":
        return cmd_stop(args)
    elif args.command == "_watchdog":
        return cmd_watchdog(args)
    else:
        parser.print_help()
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
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

Progress events are written to stderr in format `[Xs] message` � these are visible in Bash tool output.

### Exit Codes
- `0` = success
- `1` = general error
- `2` = timeout (3600s default)
- `3` = codex turn failed
- `4` = codex stalled (~3 min no output)
- `5` = codex not found in PATH

### Poll Status Codes
- `running` � Codex still working; stderr shows progress events
- `completed` � Codex finished; `THREAD_ID:<id>` on stdout, review in `<STATE_DIR>/review.txt`
- `failed` � Codex turn failed or process exited unexpectedly
- `timeout` � Exceeded timeout (default 3600s)
- `stalled` � No new output for ~3 minutes

## Step 1: Gather Configuration

Ask the user (via `AskUserQuestion`) **only one question**:
- Which reasoning effort to use (`xhigh`, `high`, `medium`, or `low`)

**Do NOT ask** which model to use — always use Codex's default model (no `-m` flag).
**Do NOT ask** how many rounds — the loop runs automatically until consensus.

## Step 2: Prepare the Plan

1. Ensure the plan is saved to a file in the project directory. If the plan only exists in conversation, write it to a file first (e.g., `.claude/plan.md`).
2. Note the **absolute path** to the plan file — you will pass this path to Codex so it can read the file itself.
3. **Do NOT paste the plan content into the Codex prompt.** Codex will read the file directly.

## Prompt Construction Principle

**Only include in the Codex prompt what Codex cannot access on its own:**
- The path to the plan file (so Codex knows where to read it)
- The user's original request / task description
- Important context from the conversation: user comments, constraints, preferences, architectural decisions discussed verbally
- Any clarifications or special instructions the user gave

**Do NOT include:**
- The plan content itself (Codex reads the file)
- Code snippets Codex can read from the repo
- Information Codex can derive by reading files

## Step 3: Send Plan to Codex for Review (Round 1)

### Step 3a — Start Codex

Run the codex-runner `start` subcommand with the bootstrap block:

```bash
PY=""
for cmd in python3 python py; do
  if command -v "$cmd" >/dev/null 2>&1; then PY="$cmd"; break; fi
done
[ -z "$PY" ] && { echo "Error: Python 3 not found" >&2; exit 1; }
RUNNER="${CODEX_RUNNER:-$HOME/.local/bin/codex-runner.py}"
NEED_INSTALL=0
if [ -n "$CODEX_RUNNER" ] && [ -f "$CODEX_RUNNER" ]; then
  if ! "$PY" "$CODEX_RUNNER" version 2>/dev/null | grep -q "^7$"; then NEED_INSTALL=1; fi
elif [ ! -f "$RUNNER" ]; then NEED_INSTALL=1
elif ! "$PY" "$RUNNER" version 2>/dev/null | grep -q "^7$"; then NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$RUNNER" <<'RUNNER_SCRIPT'
<PASTE FULL SCRIPT FROM ABOVE>
RUNNER_SCRIPT
fi
"$PY" "$RUNNER" start --working-dir <WORKING_DIR> --effort <EFFORT> <<'EOF'
<REVIEW_PROMPT>
EOF
```

The output will be: `CODEX_STARTED:<WORKING_DIR>/.codex-review/runs/<RUN_ID>`

Save the state directory path — you need it for polling and cleanup.

### Step 3b — Poll Loop

Call `poll` repeatedly to check progress. Each poll outputs status on stdout and progress on stderr:

```bash
sleep 60 && "$PY" "$RUNNER" poll <STATE_DIR>
```

After each poll:
- stdout starts with `POLL:running:` → Codex is still working. The stderr output shows progress events like `[45s] Codex running: cat plan.md`. Call poll again — use `sleep 30` for the second poll, then `sleep 15` for all subsequent polls.
- stdout starts with `POLL:completed:` → Extract thread_id from the `THREAD_ID:` line. Read the review from `<STATE_DIR>/review.txt` using the Read tool. Proceed to Step 3c.
- stdout starts with `POLL:failed:` or `POLL:timeout:` or `POLL:stalled:` → Handle per Error Handling section. Call `stop` to cleanup.

**Progress reporting**: The stderr output from the Bash tool call shows progress events (e.g., `[45s] Codex is thinking...`, `[52s] Codex running: cat plan.md`). Summarize these for the user between polls.

### Step 3c — Cleanup

After extracting the completed result (or handling an error):

```bash
"$PY" "$RUNNER" stop <STATE_DIR>
```

This kills any remaining processes and removes the state directory.

Save the `thread_id` from the `THREAD_ID:` line — you will need it for subsequent rounds.

### Review Prompt Template

```
You are participating in a plan review debate with Claude Code (Claude Opus 4.6).

## Your Role
You are the REVIEWER. Your job is to critically evaluate an implementation plan. Be thorough, constructive, and specific.

## Plan Location
Read the implementation plan from: <ABSOLUTE_PATH_TO_PLAN_FILE>

## User's Original Request
<The user's original task/request that prompted this plan>

## Session Context
<Any important context from the conversation that Codex cannot access on its own>

(If there is no additional context beyond the plan file, write "No additional context — the plan file is self-contained.")

## Instructions
1. Read the plan file above.
2. Read any source files referenced in the plan to understand the current codebase state.
3. Analyze the plan and produce your review in the EXACT format below.

## Required Output Format

For each issue found, use this structure:

### ISSUE-{N}: {Short title}
- **Category**: Critical Issue | Improvement | Question
- **Severity**: CRITICAL | HIGH | MEDIUM | LOW
- **Plan Reference**: Step {X} / Section "{name}" / Decision "{name}"
- **Description**: What the problem is, in detail.
- **Why It Matters**: Concrete scenario showing how this causes a real failure, bug, or degraded outcome.
- **Suggested Fix**: Specific proposed change to the plan. (Required for Critical Issue and Improvement. Optional for Question.)

After all issues, provide:

### VERDICT
- **Result**: REJECT | APPROVE_WITH_CHANGES | APPROVE
- **Summary**: 2-3 sentence overall assessment.

Rules:
- Be specific: reference exact steps, file paths, or decisions in the plan.
- Do NOT rubber-stamp the plan. Your value comes from finding real problems.
- Do NOT raise vague concerns without concrete scenarios.
- Every Critical Issue MUST have a Suggested Fix.
```

**After receiving Codex's review**, summarize it for the user before proceeding.

## Step 4: Claude Code Rebuts (Round 1)

After receiving Codex's review, you (Claude Code) must:

1. **Carefully analyze** each ISSUE Codex raised.
2. **Accept valid criticisms** - If Codex found real issues, acknowledge them and update the plan file.
3. **Push back on invalid points** - If you disagree with Codex's assessment, explain why with evidence. Use your own knowledge, web search, or documentation to support your position.
4. **Update the plan file** with accepted changes (use Edit tool).
5. **Summarize** for the user what you accepted, what you rejected, and why.
6. **Immediately proceed to Step 5** — do NOT ask the user whether to continue. Always send the updated plan back to Codex for re-review.

## Step 5: Continue the Debate (Rounds 2+)

### Step 5a — Start Codex (resume)

Run the runner with `--thread-id` to resume the existing Codex conversation:

```bash
PY=""
for cmd in python3 python py; do
  if command -v "$cmd" >/dev/null 2>&1; then PY="$cmd"; break; fi
done
[ -z "$PY" ] && { echo "Error: Python 3 not found" >&2; exit 1; }
RUNNER="${CODEX_RUNNER:-$HOME/.local/bin/codex-runner.py}"
NEED_INSTALL=0
if [ -n "$CODEX_RUNNER" ] && [ -f "$CODEX_RUNNER" ]; then
  if ! "$PY" "$CODEX_RUNNER" version 2>/dev/null | grep -q "^7$"; then NEED_INSTALL=1; fi
elif [ ! -f "$RUNNER" ]; then NEED_INSTALL=1
elif ! "$PY" "$RUNNER" version 2>/dev/null | grep -q "^7$"; then NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$RUNNER" <<'RUNNER_SCRIPT'
<PASTE FULL SCRIPT FROM ABOVE>
RUNNER_SCRIPT
fi
"$PY" "$RUNNER" start --working-dir <WORKING_DIR> --effort <EFFORT> --thread-id <THREAD_ID> <<'EOF'
<REBUTTAL_PROMPT>
EOF
```

### Step 5b — Poll Loop

Same as Step 3b — poll until completed, then proceed to Step 5c.

### Step 5c — Cleanup

```bash
"$PY" "$RUNNER" stop <STATE_DIR>
```

### Rebuttal Prompt Template

```
This is Claude Code (Claude Opus 4.6) responding to your review.

## Issues Accepted & Fixed
<For each accepted issue, reference by ISSUE-{N} and describe what was changed in the plan>

## Issues Disputed
<For each disputed issue, reference by ISSUE-{N} and explain why with evidence>

## Your Turn
Re-read the plan file (same path as before) to see the updated plan, then re-review.
- Have your previous concerns been properly addressed?
- Do the changes introduce any NEW issues?
- Are there any remaining problems?

Use the same output format as before (ISSUE-{N} structure + VERDICT).
Verdict options: REJECT | APPROVE_WITH_CHANGES | APPROVE
```

**After each Codex response:**
1. Summarize Codex's response for the user.
2. If Codex's verdict is `APPROVE` → proceed to Step 6.
3. If Codex's verdict is `APPROVE_WITH_CHANGES` → address the suggestions, then **automatically** send one more round to Codex for confirmation. Do NOT ask the user.
4. If Codex's verdict is `REJECT` → address the issues and **automatically** continue to next round. Do NOT ask the user.

**IMPORTANT**: The debate loop is fully automatic. After fixing issues or updating the plan, ALWAYS send it back to Codex without asking the user. The loop only stops when Codex returns `APPROVE`. The user is only consulted at the very end (Step 6) or if a stalemate is detected.

### Early Termination & Round Extension

- **Early termination**: If Codex returns `APPROVE`, end the debate immediately and proceed to Step 6.
- **Round extension**: There is no hard round limit. Continue the fix → re-review loop until either:
  - Codex returns `APPROVE`, OR
  - The same points go back and forth without progress for 2 consecutive rounds (stalemate detected) → present the disagreement to the user and let them decide.

**Repeat** Steps 4-5 until consensus or stalemate.

## Step 6: Finalize and Report

After the debate concludes, present the user with a **Debate Summary**:

```
## Debate Summary

### Rounds: X
### Final Verdict: [CONSENSUS REACHED / STALEMATE - USER DECISION NEEDED]

### Key Changes from Debate:
1. [Change 1 - accepted from Codex]
2. [Change 2 - accepted from Codex]
...

### Points Where Claude Prevailed:
1. [Point 1 - Claude's position was maintained]
...

### Points Where Codex Prevailed:
1. [Point 1 - Codex's position was accepted]
...

### Final Plan:
<Path to the updated plan file>
```

Then ask the user (via `AskUserQuestion`):
- **Approve & Implement** - Proceed with the final plan
- **Request more rounds** - Continue debating specific points
- **Modify manually** - User wants to make their own adjustments before implementing

## Step 7: Implementation

If the user approves:
1. Exit plan mode if still in it.
2. Begin implementing the final debated plan.
3. The plan has been stress-tested — implement with confidence.

## Important Rules

1. **Codex reads the plan file itself** - Do NOT paste plan content into the prompt. Just give Codex the file path.
2. **Only send what Codex can't access** - The prompt should contain: file paths, user's original request, session context. NOT: file contents, diffs, code snippets.
3. **Always use heredoc (`<<'EOF'`) for prompts** - Never use `echo "<prompt>" |`. Heredoc with single-quoted delimiter prevents shell expansion.
4. **No `-m` flag** - Always use Codex's default model.
5. **Resume by thread ID** - Use the `thread_id` from the `THREAD_ID:` line of poll completed output for subsequent rounds.
6. **Never skip the user summary** - After each round, tell the user what happened before continuing.
7. **Be genuinely adversarial** - Don't just accept everything Codex says. Push back when you have good reason to.
8. **Don't rubber-stamp** - If you think Codex missed something, point it out in your rebuttal.
9. **Track the plan evolution** - Update the plan file after each round so Codex always reads the latest version.
10. **Require structured output** - If Codex's response doesn't follow the ISSUE-{N} format, ask it to reformat in the resume prompt.
11. **Always call `stop` after getting results** - Clean up the state directory after extracting the completed result or handling errors.

## Error Handling

- If poll returns `POLL:timeout:`, inform the user and ask if they want to retry with a longer timeout. Call `stop` to cleanup.
- If poll returns `POLL:failed:`, report the error message to the user. Call `stop` to cleanup.
- If poll returns `POLL:stalled:`, ask the user whether to retry or abort. Call `stop` to cleanup.
- If the `start` command exits with code `5` (codex not found), tell the user to install the Codex CLI.
- If the debate stalls (same points going back and forth without resolution), present the disagreement to the user and let them decide.
