---
name: codex-think-about
description: Peer debate between Claude Code and Codex CLI on any question. Both AIs think independently, then discuss and refine until reaching consensus or presenting their disagreements for the user to resolve.
---

# Codex Think About — Skill Guide

## Overview
This skill orchestrates a **peer debate** between Claude Code and OpenAI Codex CLI on any question or topic. Unlike the review skills where one side reviews and the other implements, here both AIs are **equal thinkers** — each forms independent perspectives, then they discuss, refine, and challenge each other's reasoning until reaching consensus or identifying irreducible disagreements.

**Codex and Claude Code are EQUAL PEERS.** Neither is the reviewer or the implementer. Both contribute ideas, evidence, and counterarguments.

**Flow:** User question → Claude Code gathers factual context → Codex thinks independently → Claude Code responds with own perspective → Codex responds → ... → Consensus or Stalemate → Present to user

## Prerequisites
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

## Step 1: Parse Query & Gather Config

1. The query comes from the skill invocation: `/codex-think-about <query>`
2. If the query is empty, ask the user via `AskUserQuestion` what they want to think about.
3. Ask the user (via `AskUserQuestion`) **only one question**: effort level.

Effort level options:
- **low** — Quick initial thoughts (maps to Codex `model_reasoning_effort=low`)
- **medium** — Balanced analysis (maps to Codex `model_reasoning_effort=medium`)
- **high** — Deep thinking (maps to Codex `model_reasoning_effort=high`) (Recommended)
- **deep** — Maximum reasoning effort (maps to Codex `model_reasoning_effort=high`)

**Do NOT ask** which model to use — always use Codex's default model (no `-m` flag).

## Step 2: Gather Factual Context (NO opinion, NO analysis)

Claude Code gathers **facts only** so Codex has context without being biased by Claude Code's perspective. This keeps Codex's initial thinking independent.

Collect:
1. **Project info** — language, framework, key directories. Factual only.
2. **Conversation facts** — constraints the user mentioned, decisions already made, tech stack, file paths referenced. Only record facts, do NOT interpret or analyze.
3. **Relevant files** (if the query relates to code) — find 3-8 relevant file paths with a one-line factual description each. Do NOT paste code content, do NOT add commentary. If the query is purely conceptual, skip this.

**Principle**: Only send what Codex cannot access on its own. Keep Codex thinking **independently**.

## Step 3: Send to Codex — Round 1 (start/poll/stop)

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
"$PY" "$RUNNER" start --working-dir <WORKING_DIR> --effort <EFFORT> --timeout 1800 <<'EOF'
<THINKING_PROMPT>
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
- stdout starts with `POLL:running:` → Codex is still working. Call poll again — use `sleep 30` for the second poll, then `sleep 15` for all subsequent polls.
- stdout starts with `POLL:completed:` → Extract thread_id from the `THREAD_ID:` line. Read the analysis from `<STATE_DIR>/review.txt` using the Read tool. Proceed to Step 3c.
- stdout starts with `POLL:failed:` or `POLL:timeout:` or `POLL:stalled:` → Handle per Error Handling section.

**Progress reporting**: Summarize progress events from stderr for the user between polls.

### Step 3c — Cleanup

After extracting the completed result (or handling an error):

```bash
"$PY" "$RUNNER" stop <STATE_DIR>
```

Save the `thread_id` — you will need it for subsequent rounds.

After cleanup, **summarize Codex's analysis for the user** (progress update).

### Codex Prompt Template (Round 1)

```
You are an independent technical thinker participating in a peer discussion with Claude Code (Claude Opus 4.6).

## Your Role
Think deeply and independently about the question below. You and Claude Code are EQUAL PEERS — neither is the authority. Your value comes from independent analysis. After this round, Claude Code will respond with its own perspective, and you will discuss until you reach agreement or identify where you fundamentally disagree.

## Question
<USER_QUERY>

## Project Context
<Language, framework, key components. "N/A" if not project-specific.>

## Relevant Files
<File paths with one-line descriptions, or "No specific files — general question.">

## Known Constraints
<Factual constraints from conversation — decisions already made, requirements, limitations. NO opinions from Claude Code.>

## Instructions
1. Read relevant files if listed.
2. Think independently. Consider: multiple approaches, trade-offs, edge cases, what the asker might not have considered.
3. Produce analysis in the format below.

## Required Output Format

### Key Insights
1. [Insight with evidence]
...

### Considerations
- **[Aspect]**: [Analysis]
...

### Recommendations
1. [Actionable recommendation]
...

### Open Questions
- [Question warranting further exploration]
...

### Confidence Level
[HIGH | MEDIUM | LOW] — [Explanation]

Rules:
- Be specific, not abstract. Reference actual files when relevant.
- Acknowledge uncertainty honestly.
- Focus on 3-5 most important dimensions.
- Take clear positions where you have evidence — do NOT hedge everything.
```

## Step 4: Claude Code Responds

After reading Codex's analysis from `<STATE_DIR>/review.txt`:

1. **Analyze each point** Codex raised.
2. **Agree** with points that are well-reasoned — state "Agree with Codex because..."
3. **Disagree** with points where you have counter-evidence — provide your own reasoning and evidence.
4. **Add** perspectives Codex missed — introduce new insights or dimensions.
5. **Synthesize**: Clearly identify what is consensus and what is disagreement.
6. **Summarize for the user** before sending to Codex.

**Disagreement tracking**: Maintain a registry across rounds:
- Each disagreement gets an ID (D-1, D-2, ...), a status (open/resolved), and the round it was last changed.
- "Progress" means at least one of: a disagreement resolved, new evidence added, or a new dimension raised.

## Step 5: Send Response to Codex — Round 2+ (resume thread)

### Step 5a — Start Codex (resume)

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
"$PY" "$RUNNER" start --working-dir <WORKING_DIR> --effort <EFFORT> --timeout 1800 --thread-id <THREAD_ID> <<'EOF'
<RESPONSE_PROMPT>
EOF
```

### Step 5b — Poll Loop

Same as Step 3b — poll until completed, then proceed to Step 5c.

### Step 5c — Cleanup

```bash
"$PY" "$RUNNER" stop <STATE_DIR>
```

Read Codex's response from `<STATE_DIR>/review.txt`, then return to Step 4.

If timeout/stall/fail occurs, retry once per Error Handling policy (timeout → double to 3600s; failed/stalled → same timeout).

### Response Prompt Template (Round 2+ — Claude Code → Codex)

```
This is Claude Code (Claude Opus 4.6) responding to your analysis. We are peer thinkers discussing the same question.

## Points I Agree With
<For each agreed point, reference which insight/recommendation and briefly explain why>

## Points I Disagree With
<For each disagreement, reference the specific point and provide counter-reasoning with evidence>

## Additional Perspectives
<New insights or dimensions Claude Code identified that Codex didn't cover>

## Current Status
- **Agreed**: [list of consensus points]
- **Disagreed**: [list of remaining disagreements]

## Your Turn
Consider my responses above. For points of disagreement:
- If my reasoning is convincing, feel free to update your position.
- If you still disagree, explain why with additional evidence.
- If we're going in circles on a point, say so explicitly.

For new perspectives I raised:
- Share your thoughts — agree, disagree, or expand.

Use the same output format as before (Key Insights, Considerations, Recommendations, Open Questions, Confidence Level).
Add a section at the end:

### Discussion Status
- **Consensus Points**: [points both sides now agree on]
- **Remaining Disagreements**: [points still contested]
- **New Points**: [any new dimensions raised in this round]
```

## Auto-loop & Termination

The debate loop runs **fully automatically** — do NOT ask the user between rounds. The user is only informed via progress summaries after each round.

### Consensus Detection

After each round, check:
- All disagreements resolved → **CONSENSUS** → Step 6
- Codex explicitly agrees / says "no further concerns" → **CONSENSUS** → Step 6

### Stalemate Detection

- Same disagreements remain open AND no progress (per definition above) for **2 consecutive rounds** → **STALEMATE** → Step 6

### Hard Cap

Maximum **6 Codex turns** (codex_turns) as a safety net:
- Turn 1: Codex initial thinking
- Turn 2: Codex responds to Claude Code
- Turn 3+: Subsequent rounds
- If turn 6 reached without consensus → end as **STALEMATE**

Each turn = one start+poll+stop cycle.

## Step 6: Present Result to User

Present a **Thinking Session Summary**:

```
## Thinking Session Summary

### Question: <original query>
### Rounds: X
### Result: CONSENSUS / STALEMATE / TECHNICAL_FAILURE

### Key Insights (from the discussion):
1. [Insight — who raised it, how the other side responded]
...

### Considerations
- **[Aspect]**: [Analysis — consensus or disagreement]
...

### Recommendations:
1. [Recommendation — consensus or majority position]
...

### Open Questions (worth exploring further):
- [Question]
...

### Confidence Level
[HIGH | MEDIUM | LOW] — [Explanation based on consensus level achieved]

### Consensus/Disagreement Status
- **Agreed Points**: [list]
- **Unresolved Disagreements** (if stalemate): [Claude Code's position vs Codex's position for each point]
```

Then ask via `AskUserQuestion`:
- **Follow-up question** — ask more (starts a new thinking round with both AIs)
- **Done** — end the session

If the user chooses follow-up → **always start a new thread** (new question needs Codex to think independently). Only resume the old thread if the user explicitly says "continue exactly where we left off". When starting a new thread, pass a structured facts summary from the previous session (not the full thread).

## Important Rules

1. **Factual context only** — Do NOT send Claude Code's opinions or analysis in the Round 1 prompt. Keep Codex independent for initial thinking.
2. **Peer debate, not hierarchical** — Claude Code does NOT direct Codex. Both are equals.
3. **Codex reads files itself** — only list paths, do NOT paste file content.
4. **Heredoc `<<'EOF'`** for all prompts.
5. **No `-m` flag** — always use Codex's default model.
6. **Resume by thread ID** for rounds 2+.
7. **Summarize after every round** — user sees progress without intervening.
8. **Auto-loop** — do NOT ask user between rounds. Loop automatically until consensus/stalemate.
9. **Stalemate = 2 rounds without progress** — same disagreements, no new evidence or dimensions.
10. **Always call `stop`** after extracting results from each round.
11. **Best-effort parsing** — if Codex output doesn't match format exactly, parse what you can. Content matters more than format for a thinking skill.
12. **Track disagreements** — maintain a disagreement registry (D-1, D-2, ...) with status across rounds to detect stalemate.

## Error Handling

All error handling is **fully automatic** — do not ask the user during the loop.

**Timeout policy**: base timeout = 1800s. Retry uses timeout x2 = 3600s.

- `POLL:timeout:` → auto-retry once with `--timeout 3600`. If still timeout → end with `TECHNICAL_FAILURE`, present to user at Step 6. Call `stop`.
- `POLL:failed:` → auto-retry once (same timeout). If still fails → end with `TECHNICAL_FAILURE`. Call `stop`.
- `POLL:stalled:` → auto-retry once (same timeout). If still stalls → end with `TECHNICAL_FAILURE`. Call `stop`.
- Exit code 5 → end immediately, tell user to install Codex CLI at Step 6.
- Malformed output → parse best-effort, extract key content. Do not request reformatting (content matters more than format for thinking).
