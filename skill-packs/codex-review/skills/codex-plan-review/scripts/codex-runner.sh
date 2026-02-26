#!/usr/bin/env bash
set -euo pipefail

# IMPORTANT: Bump CODEX_RUNNER_VERSION when changing this script.
# This script is shared by all codex-review skills in the skill pack.
CODEX_RUNNER_VERSION="6"

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
      python3 "$PROC_HELPER" kill-tree "$pgid" 2>/dev/null || true
    fi
    local wpid="${WATCHDOG_PID:-}"
    if [[ -n "$wpid" ]]; then
      local wpid_status
      wpid_status=$(python3 "$PROC_HELPER" is-alive "$wpid" 2>/dev/null || echo "dead")
      if [[ "$wpid_status" == "alive" ]]; then
        python3 "$PROC_HELPER" kill-single "$wpid" 2>/dev/null || true
      fi
    fi
    rm -rf "$STATE_DIR"
  }
  trap startup_cleanup EXIT

  # --- Detach Codex process via cross-platform helper ---
  LAUNCH_RESULT=$(python3 "$PROC_HELPER" launch "$STATE_DIR" "$WORKING_DIR" "$TIMEOUT" "$THREAD_ID" "$EFFORT")

  CODEX_PID=$(echo "$LAUNCH_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['pid'])")
  CODEX_PGID=$(echo "$LAUNCH_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['pgid'])")

  # --- Watchdog timeout (detached) ---
  python3 "$PROC_HELPER" watchdog "$TIMEOUT" "$CODEX_PGID" &
  WATCHDOG_PID=$!
  disown $WATCHDOG_PID 2>/dev/null || true

  # --- Verify process is alive ---
  sleep 1
  ALIVE_CHECK=$(python3 "$PROC_HELPER" is-alive "$CODEX_PID" 2>/dev/null || echo "dead")
  if [[ "$ALIVE_CHECK" != "alive" ]]; then
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

  # --- Check if PID is alive (cross-platform) ---
  PROCESS_ALIVE=1
  ALIVE_CHECK=$(python3 "$PROC_HELPER" is-alive "$CODEX_PID" 2>/dev/null || echo "dead")
  if [[ "$ALIVE_CHECK" != "alive" ]]; then
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

  # --- Helper: verify PID belongs to codex before killing (cross-platform) ---
  verify_and_kill_codex() {
    local pid="$1" pgid="$2"
    local status
    status=$(python3 "$PROC_HELPER" verify-codex "$pid" 2>/dev/null || echo "dead")
    case "$status" in
      dead) return 0 ;;
      verified|unknown) python3 "$PROC_HELPER" kill-tree "$pgid" 2>/dev/null || true ;;
      mismatch) ;; # PID reused by different process — do not kill
    esac
  }
  verify_and_kill_watchdog() {
    local pid="$1"
    local status
    status=$(python3 "$PROC_HELPER" verify-watchdog "$pid" 2>/dev/null || echo "dead")
    case "$status" in
      dead) return 0 ;;
      verified|unknown) python3 "$PROC_HELPER" kill-single "$pid" 2>/dev/null || true ;;
      mismatch) ;;
    esac
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
" "$STATE_DIR" "$LAST_LINE_COUNT" "$ELAPSED" "$PROCESS_ALIVE" "$TIMEOUT")

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

    # Kill Codex process group (verify identity via cross-platform helper)
    if [[ -n "$CODEX_PID" && -n "$CODEX_PGID" ]]; then
      VERIFY_STATUS=$(python3 "$PROC_HELPER" verify-codex "$CODEX_PID" 2>/dev/null || echo "dead")
      if [[ "$VERIFY_STATUS" == "verified" || "$VERIFY_STATUS" == "unknown" ]]; then
        python3 "$PROC_HELPER" kill-tree "$CODEX_PGID" 2>/dev/null || true
      fi
    fi

    # Kill watchdog (verify identity)
    if [[ -n "$WATCHDOG_PID" ]]; then
      VERIFY_WD=$(python3 "$PROC_HELPER" verify-watchdog "$WATCHDOG_PID" 2>/dev/null || echo "dead")
      if [[ "$VERIFY_WD" == "verified" || "$VERIFY_WD" == "unknown" ]]; then
        python3 "$PROC_HELPER" kill-single "$WATCHDOG_PID" 2>/dev/null || true
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
    if [[ -n "$codex_pid_local" ]]; then
      local alive_status
      alive_status=$(python3 "$PROC_HELPER" is-alive "$codex_pid_local" 2>/dev/null || echo "dead")
      if [[ "$alive_status" == "alive" ]]; then
        python3 "$PROC_HELPER" kill-single "$codex_pid_local" 2>/dev/null || true
        wait "$codex_pid_local" 2>/dev/null || true
      fi
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
      python3 "$PROC_HELPER" kill-single "$CODEX_PID" 2>/dev/null || true
      exit $EXIT_TIMEOUT
    fi

    ALIVE_CHECK=$(python3 "$PROC_HELPER" is-alive "$CODEX_PID" 2>/dev/null || echo "dead")
    if [[ "$ALIVE_CHECK" != "alive" ]]; then
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
      python3 "$PROC_HELPER" kill-single "$CODEX_PID" 2>/dev/null || true
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
