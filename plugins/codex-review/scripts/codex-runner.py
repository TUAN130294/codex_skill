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
