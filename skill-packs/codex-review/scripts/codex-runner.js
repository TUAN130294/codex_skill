#!/usr/bin/env node

/**
 * codex-runner.js — Cross-platform runner for Codex CLI (Node.js stdlib only).
 *
 * Replaces codex-runner.sh + codex-runner.py in a single file.
 * Subcommands: version, init, start, resume, poll, stop, _watchdog
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// --- Constants ---
const CODEX_RUNNER_VERSION = 12;

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_TIMEOUT = 2;
const EXIT_TURN_FAILED = 3;
const EXIT_STALLED = 4;
const EXIT_CODEX_NOT_FOUND = 5;

const IS_WIN = process.platform === "win32";

// ============================================================
// Process management
// ============================================================

/**
 * Resolve the codex CLI command for spawning.
 *
 * On Windows, npm-installed CLIs are .cmd wrappers (e.g. codex.cmd).
 * Node.js spawn() cannot resolve .cmd files without shell: true,
 * but shell: true + detached: true drops stdio on Windows.
 * Instead, resolve the underlying codex.js entry point and invoke
 * it directly via node.exe — no shell needed.
 */
function resolveCodexCommand() {
  if (!IS_WIN) {
    return { cmd: "codex", prependArgs: [] };
  }

  // Try to find codex.js via npm global prefix
  const r = spawnSync("npm", ["config", "get", "prefix"], {
    encoding: "utf8",
    shell: true,
    timeout: 10000,
  });
  if (r.status === 0 && r.stdout) {
    const prefix = r.stdout.trim();
    const codexJs = path.join(
      prefix, "node_modules", "@openai", "codex", "bin", "codex.js",
    );
    if (fs.existsSync(codexJs)) {
      return { cmd: process.execPath, prependArgs: [codexJs] };
    }
  }

  // Fallback: try common npm global path on Windows
  const appData = process.env.APPDATA;
  if (appData) {
    const codexJs = path.join(
      appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js",
    );
    if (fs.existsSync(codexJs)) {
      return { cmd: process.execPath, prependArgs: [codexJs] };
    }
  }

  // Last resort: assume "codex" is directly executable (non-npm install)
  return { cmd: "codex", prependArgs: [] };
}

function launchCodex(stateDir, workingDir, timeoutS, threadId, effort, sandbox = "read-only") {
  const promptFile = path.join(stateDir, "prompt.txt");
  const jsonlFile = path.join(stateDir, "output.jsonl");
  const errFile = path.join(stateDir, "error.log");

  const { cmd: resolvedCmd, prependArgs } = resolveCodexCommand();
  let cmd = resolvedCmd;
  let args;
  let cwd;

  if (threadId) {
    args = [
      ...prependArgs, "exec", "--skip-git-repo-check", "--json",
      "--config", `model_reasoning_effort=${effort}`,
      "resume", threadId, "-",
    ];
    cwd = workingDir;
  } else {
    args = [
      ...prependArgs,
      "exec", "--skip-git-repo-check", "--json",
      "--sandbox", sandbox,
      "--config", `model_reasoning_effort=${effort}`,
      "-C", workingDir,
    ];
    cwd = undefined;
  }

  const fin = fs.openSync(promptFile, "r");
  const fout = fs.openSync(jsonlFile, "w");
  const ferr = fs.openSync(errFile, "w");

  const spawnOpts = {
    stdio: [fin, fout, ferr],
    detached: true,
    cwd,
  };

  if (IS_WIN) {
    spawnOpts.windowsHide = true;
  }

  const child = spawn(cmd, args, spawnOpts);
  child.unref();

  const pid = child.pid;

  if (pid === undefined) {
    throw new Error(`Failed to spawn "${cmd}" — process did not start (ENOENT). Is codex installed globally?`);
  }

  // Close file descriptors in parent
  fs.closeSync(fin);
  fs.closeSync(fout);
  fs.closeSync(ferr);

  return { pid, pgid: pid };
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDescendantPids(rootPid) {
  if (IS_WIN) return [];
  const descendants = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const ppid = queue.shift();
    try {
      const result = spawnSync("pgrep", ["-P", String(ppid)], {
        encoding: "utf8", timeout: 5000,
      });
      if (result.status === 0 && result.stdout) {
        const children = result.stdout.trim().split("\n")
          .map(s => parseInt(s.trim(), 10))
          .filter(n => !isNaN(n) && n > 0);
        for (const child of children) {
          if (!descendants.includes(child)) {
            descendants.push(child);
            queue.push(child);
          }
        }
      }
    } catch {
      // Lỗi tạm trên node này → bỏ qua node, tiếp tục BFS các node khác.
      // Chỉ khi pgrep hoàn toàn không tồn tại (ENOENT), mới ngừng traversal.
      continue;
    }
  }
  return descendants;
}

function syncSleep(ms) {
  const result = spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`], {
    timeout: ms + 2000,
  });
  // spawnSync trả error object khi spawn thất bại (ENOENT, ENOMEM...), không throw
  if (result.error) {
    // Fallback: Atomics.wait — không cần subprocess, hoạt động khi tài nguyên thấp
    try {
      const sab = new SharedArrayBuffer(4);
      const view = new Int32Array(sab);
      Atomics.wait(view, 0, 0, ms);
    } catch {
      // Last resort: không sleep → SIGKILL gửi ngay (vẫn đúng logic, chỉ mất grace period)
    }
  }
}

function killTree(pid) {
  if (!pid || pid <= 1) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      return;
    }

    // Phase 1: Snapshot descendants TRƯỚC khi gửi signal
    const descendants = getDescendantPids(pid);

    // Phase 2: SIGTERM process group + từng descendant
    try { process.kill(-pid, "SIGTERM"); } catch {}
    for (const dpid of descendants) {
      try { process.kill(dpid, "SIGTERM"); } catch {}
    }

    // Phase 3: Grace period + rescan
    syncSleep(2000);

    // Rescan: bắt workers mới fork sau SIGTERM.
    // Seed BFS từ root + descendants còn alive (vì nếu root chết, orphans bị reparent
    // sang init → pgrep -P rootPid trả rỗng → BFS chỉ từ root sẽ bỏ sót).
    const rescanSeeds = [pid, ...descendants.filter(d => isAlive(d))];
    const rescanned = [];
    for (const seed of rescanSeeds) {
      for (const dp of getDescendantPids(seed)) {
        if (!rescanned.includes(dp)) rescanned.push(dp);
      }
    }
    const allPids = new Set([...descendants, ...rescanned]);

    // Phase 4: SIGKILL survivors
    try { process.kill(-pid, "SIGKILL"); } catch {}
    for (const dpid of allPids) {
      // Guard: chỉ kill nếu process vẫn alive (đã chết = SIGTERM thành công = skip)
      if (isAlive(dpid)) {
        try { process.kill(dpid, "SIGKILL"); } catch {}
      }
    }
  } catch {}
}

function killSingle(pid) {
  if (!pid || pid <= 1) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
      return;
    }
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    syncSleep(500);
    // PID-reuse guard cho killSingle: verify vẫn alive trước SIGKILL
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {}
}

function getCmdline(pid) {
  try {
    if (IS_WIN) {
      // Try PowerShell first
      try {
        const result = spawnSync(
          "powershell",
          ["-NoProfile", "-Command",
           `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { encoding: "utf8", timeout: 10000 },
        );
        const cmdline = (result.stdout || "").trim();
        if (cmdline) return cmdline;
      } catch {
        // PowerShell not available
      }
      // Fallback to wmic
      try {
        const result = spawnSync(
          "wmic",
          ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
          { encoding: "utf8", timeout: 5000 },
        );
        for (const line of (result.stdout || "").split("\n")) {
          if (line.startsWith("CommandLine=")) {
            return line.slice("CommandLine=".length).trim();
          }
        }
      } catch {
        // wmic not available
      }
      return null;
    }

    // Unix
    const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0 ? (result.stdout || "").trim() : null;
  } catch {
    return null;
  }
}

function verifyCodex(pid) {
  if (!isAlive(pid)) return "dead";
  const cmdline = getCmdline(pid);
  if (cmdline === null) return "unknown";
  if (cmdline.includes("codex exec") || cmdline.includes("codex.exe exec") || cmdline.includes("codex.js") && cmdline.includes("exec")) {
    return "verified";
  }
  return "mismatch";
}

function verifyWatchdog(pid) {
  if (!isAlive(pid)) return "dead";
  const cmdline = getCmdline(pid);
  if (cmdline === null) return "unknown";
  if (cmdline.includes("node") && cmdline.includes("_watchdog")) {
    return "verified";
  }
  return "mismatch";
}

function launchWatchdog(timeoutS, targetPid) {
  const script = path.resolve(__filename);
  const nodeExe = process.execPath;
  const args = [script, "_watchdog", String(timeoutS), String(targetPid)];

  const spawnOpts = {
    stdio: "ignore",
    detached: true,
  };
  if (IS_WIN) {
    spawnOpts.windowsHide = true;
  }

  const child = spawn(nodeExe, args, spawnOpts);
  child.unref();
  return child.pid;
}

// ============================================================
// File I/O
// ============================================================

function atomicWrite(filepath, content) {
  const dirpath = path.dirname(filepath);
  const tmpPath = path.join(dirpath, `.${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filepath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function readState(stateDir) {
  const stateFile = path.join(stateDir, "state.json");
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function updateState(stateDir, updates) {
  const state = readState(stateDir);
  Object.assign(state, updates);
  atomicWrite(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));
  return state;
}

// ============================================================
// JSONL parsing
// ============================================================

function parseJsonl(stateDir, lastLineCount, elapsed, processAlive, timeoutVal, state) {
  const jsonlFile = path.join(stateDir, "output.jsonl");
  const errFile = path.join(stateDir, "error.log");

  let allLines = [];
  if (fs.existsSync(jsonlFile)) {
    const content = fs.readFileSync(jsonlFile, "utf8");
    allLines = content.split("\n").filter(l => l.trim());
  }

  let turnCompleted = false;
  let turnFailed = false;
  let turnFailedMsg = "";
  let extractedThreadId = "";
  let reviewText = "";

  // Parse ALL lines for terminal state + data extraction
  for (const rawLine of allLines) {
    const line = rawLine.trim();
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const t = d.type || "";

    if (t === "thread.started" && d.thread_id) {
      extractedThreadId = d.thread_id;
    }

    if (t === "turn.completed") {
      turnCompleted = true;
    } else if (t === "turn.failed") {
      turnFailed = true;
      turnFailedMsg = (d.error && d.error.message) || "unknown error";
    }

    if (t === "item.completed") {
      const item = d.item || {};
      if (item.type === "agent_message") {
        reviewText = item.text || "";
      }
    }
  }

  // Parse NEW lines for progress events + build activity summary
  const stderrLines = [];
  const activities = [];
  let completedCount = 0;
  const newLines = allLines.slice(lastLineCount);
  for (const rawLine of newLines) {
    const line = rawLine.trim();
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const t = d.type || "";
    const item = d.item || {};
    const itemType = item.type || "";

    if (t === "turn.started") {
      stderrLines.push(`[${elapsed}s] Codex is thinking...`);
    } else if (t === "item.completed" && itemType === "reasoning") {
      let text = item.text || "";
      if (text.length > 150) text = text.slice(0, 150) + "...";
      stderrLines.push(`[${elapsed}s] Codex thinking: ${text}`);
      // Activity summary: shorter version
      let summaryText = item.text || "";
      if (summaryText.length > 100) summaryText = summaryText.slice(0, 100) + "...";
      activities.push(`analyzing: ${summaryText}`);
    } else if (t === "item.started" && itemType === "command_execution") {
      stderrLines.push(`[${elapsed}s] Codex running: ${item.command || ""}`);
      const cmd = item.command || "";
      if (cmd.includes("cat ") || cmd.includes("head ")) {
        const file = cmd.split(/\s+/).pop();
        activities.push(`reading: ${file}`);
      } else if (cmd.includes("rg ") || cmd.includes("grep ")) {
        const match = cmd.match(/['"]([^'"]+)['"]/);
        activities.push(`searching for: ${match ? match[1] : "pattern"}`);
      } else if (cmd.includes("git diff")) {
        activities.push("reading git diff");
      } else {
        activities.push(`running: ${cmd.slice(0, 80)}`);
      }
    } else if (t === "item.completed" && itemType === "command_execution") {
      stderrLines.push(`[${elapsed}s] Codex completed: ${item.command || ""}`);
      completedCount++;
    } else if (t === "item.completed" && itemType === "file_change") {
      for (const c of (item.changes || [])) {
        stderrLines.push(`[${elapsed}s] Codex changed: ${c.path || "?"} (${c.kind || "?"})`);
      }
    }
  }

  const summary = activities.length > 0
    ? activities.slice(-3).join("; ")
    : (completedCount > 0 ? `completed ${completedCount} commands` : "thinking...");

  function sanitizeMsg(s) {
    if (s == null) return "unknown error";
    return String(s).replace(/\s+/g, " ").trim();
  }

  // Determine status
  const stdoutParts = [];
  if (turnCompleted) {
    if (!extractedThreadId || !reviewText) {
      const errorDetail = !extractedThreadId ? "no thread_id" : "no agent_message";
      stdoutParts.push(`POLL:failed:${elapsed}s:1:turn.completed but ${errorDetail}`);
    } else {
      atomicWrite(path.join(stateDir, "review.md"), reviewText);

      stdoutParts.push(`POLL:completed:${elapsed}s`);
      stdoutParts.push(`THREAD_ID:${extractedThreadId}`);
    }
  } else if (turnFailed) {
    stdoutParts.push(`POLL:failed:${elapsed}s:3:Codex turn failed: ${sanitizeMsg(turnFailedMsg)}`);
  } else if (!processAlive) {
    if (timeoutVal > 0 && elapsed >= timeoutVal) {
      stdoutParts.push(`POLL:timeout:${elapsed}s:2:Timeout after ${timeoutVal}s`);
    } else {
      let errContent = "";
      if (fs.existsSync(errFile)) {
        errContent = fs.readFileSync(errFile, "utf8").trim();
      }
      let errorMsg = "Codex process exited unexpectedly";
      if (errContent) {
        errorMsg += ": " + sanitizeMsg(errContent.slice(0, 200));
      }
      stdoutParts.push(`POLL:failed:${elapsed}s:1:${errorMsg}`);
    }
  } else {
    stdoutParts.push(`POLL:running:${elapsed}s`);
  }

  return { stdoutOutput: stdoutParts.join("\n"), stderrLines, summary, extractedThreadId };
}

// ============================================================
// Validation helpers
// ============================================================

function validateStateDir(stateDir) {
  let resolved;
  try {
    resolved = fs.realpathSync(stateDir);
  } catch {
    return { dir: null, err: "Invalid or missing state directory" };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { dir: null, err: "Invalid or missing state directory" };
  }

  const stateFile = path.join(resolved, "state.json");
  if (!fs.existsSync(stateFile)) {
    return { dir: null, err: "state.json not found" };
  }

  // Reconstruct expected path from state.json and compare
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const wd = fs.realpathSync(s.working_dir || "");
    const sid = s.session_id || "";
    const rid = s.run_id || "";
    let expected;
    if (sid) {
      expected = path.join(wd, ".codex-review", "sessions", sid);
    } else if (rid) {
      expected = path.join(wd, ".codex-review", "runs", rid);
    } else {
      return { dir: null, err: "state.json missing session_id/run_id" };
    }
    const actual = fs.realpathSync(resolved);
    if (expected !== actual) {
      return { dir: null, err: "state directory path mismatch" };
    }
  } catch {
    return { dir: null, err: "state.json validation error" };
  }

  return { dir: resolved, err: null };
}

function verifyAndKillCodex(pid, pgid) {
  if (!pid || pid <= 1 || !pgid || pgid <= 1) return;
  const status = verifyCodex(pid);
  if (status === "verified" || status === "unknown") {
    killTree(pgid);
  }
}

function verifyAndKillWatchdog(pid) {
  if (!pid || pid <= 1) return;
  const status = verifyWatchdog(pid);
  if (status === "verified" || status === "unknown") {
    killSingle(pid);
  }
}

// ============================================================
// Stdin reading
// ============================================================

function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let bytesRead;
  try {
    while (true) {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.slice(0, bytesRead)));
    }
  } catch {
    // EOF or pipe closed
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ============================================================
// Subcommands
// ============================================================

function cmdInit(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "skill-name": { type: "string" },
      "working-dir": { type: "string" },
    },
    strict: true,
  });

  const skillName = values["skill-name"];
  const workingDir = values["working-dir"];

  if (!skillName) {
    process.stderr.write("Error: --skill-name is required\n");
    return EXIT_ERROR;
  }
  if (!workingDir) {
    process.stderr.write("Error: --working-dir is required\n");
    return EXIT_ERROR;
  }

  let resolvedWorkingDir;
  try {
    resolvedWorkingDir = fs.realpathSync(workingDir);
  } catch {
    process.stderr.write(`Error: working directory does not exist: ${workingDir}\n`);
    return EXIT_ERROR;
  }

  // Generate session ID: {skill}-{yyyymmdd}-{NNN}
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${skillName}-${today}-`;
  const sessionsBase = path.join(resolvedWorkingDir, ".codex-review", "sessions");
  fs.mkdirSync(sessionsBase, { recursive: true });

  let maxN = 0;
  try {
    for (const d of fs.readdirSync(sessionsBase)) {
      if (d.startsWith(prefix)) {
        const n = parseInt(d.slice(prefix.length), 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
    }
  } catch {}

  // Atomic session dir creation — retry on EEXIST (parallel init race)
  let sessionDir;
  let sessionId;
  let created = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    sessionId = `${prefix}${String(maxN + 1 + attempt).padStart(3, "0")}`;
    sessionDir = path.join(sessionsBase, sessionId);
    try {
      fs.mkdirSync(sessionDir); // NOT recursive — fails with EEXIST if already taken
      created = true;
      break;
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
  }

  if (!created) {
    process.stderr.write("Error: could not reserve session directory after 10 attempts\n");
    return EXIT_ERROR;
  }

  process.stdout.write(`CODEX_SESSION:${sessionDir}\n`);
  return EXIT_SUCCESS;
}

function cmdStart(argv) {
  // First positional arg is SESSION_DIR
  const sessionDir = argv[0];
  if (!sessionDir) {
    process.stderr.write("Error: session directory argument required\n");
    return EXIT_ERROR;
  }

  // Parse remaining args
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      effort: { type: "string", default: "high" },
      timeout: { type: "string", default: "3600" },
      sandbox: { type: "string", default: "read-only" },
    },
    strict: true,
  });

  const effort = values.effort || "high";
  const timeout = parseInt(values.timeout || "3600", 10);
  const sandbox = values.sandbox || "read-only";

  const VALID_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
  if (!VALID_SANDBOXES.includes(sandbox)) {
    process.stderr.write(`Error: --sandbox must be one of: ${VALID_SANDBOXES.join(", ")}\n`);
    return EXIT_ERROR;
  }

  // Validate session dir exists
  let resolvedSessionDir;
  try {
    resolvedSessionDir = fs.realpathSync(sessionDir);
  } catch {
    process.stderr.write(`Error: session directory does not exist: ${sessionDir}\n`);
    return EXIT_ERROR;
  }

  // Infer working dir from session dir (3 levels up: sessions/ → .codex-review/ → working_dir/)
  const resolvedWorkingDir = path.resolve(resolvedSessionDir, "..", "..", "..");
  const sessionId = path.basename(resolvedSessionDir);

  // Check codex in PATH
  const whichCmd = IS_WIN ? "where" : "which";
  const probe = spawnSync(whichCmd, ["codex"], { encoding: "utf8" });
  if (probe.status !== 0) {
    process.stderr.write("Error: codex CLI not found in PATH\n");
    return EXIT_CODEX_NOT_FOUND;
  }

  // Read prompt from stdin
  const prompt = readStdinSync();
  if (!prompt.trim()) {
    process.stderr.write("Error: no prompt provided on stdin\n");
    return EXIT_ERROR;
  }

  // Write prompt (session dir already exists from init)
  fs.writeFileSync(path.join(resolvedSessionDir, "prompt.txt"), prompt, "utf8");

  // Track for rollback
  let codexPgid = null;
  let watchdogPid = null;

  function startupCleanup() {
    if (codexPgid !== null) {
      killTree(codexPgid);
    }
    if (watchdogPid !== null && isAlive(watchdogPid)) {
      killSingle(watchdogPid);
    }
    // Session mode: do NOT delete session dir on startup failure
  }

  try {
    // Launch Codex (no threadId for start — round 1)
    const { pid: codexPid, pgid } = launchCodex(
      resolvedSessionDir, resolvedWorkingDir, timeout, "", effort, sandbox,
    );
    codexPgid = pgid;

    // Launch watchdog
    watchdogPid = launchWatchdog(timeout, codexPgid);

    // Write state.json atomically
    const now = Math.floor(Date.now() / 1000);
    const state = {
      session_id: sessionId,
      pid: codexPid,
      pgid: codexPgid,
      watchdog_pid: watchdogPid,
      state_dir: resolvedSessionDir,
      working_dir: resolvedWorkingDir,
      effort,
      sandbox,
      timeout,
      started_at: now,
      thread_id: "",
      last_line_count: 0,
      stall_count: 0,
      last_poll_at: 0,
    };
    atomicWrite(path.join(resolvedSessionDir, "state.json"), JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    startupCleanup();
    return EXIT_ERROR;
  }

  // Success
  process.stdout.write(`CODEX_STARTED:${resolvedSessionDir}\n`);
  return EXIT_SUCCESS;
}

function cmdResume(argv) {
  // First positional arg is SESSION_DIR
  const sessionDir = argv[0];
  if (!sessionDir) {
    process.stderr.write("Error: session directory argument required\n");
    return EXIT_ERROR;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      effort: { type: "string", default: "high" },
      timeout: { type: "string", default: "3600" },
    },
    strict: true,
  });

  const effort = values.effort || "high";
  const timeout = parseInt(values.timeout || "3600", 10);

  // Validate session dir exists
  let resolvedSessionDir;
  try {
    resolvedSessionDir = fs.realpathSync(sessionDir);
  } catch {
    process.stderr.write(`Error: session directory does not exist: ${sessionDir}\n`);
    return EXIT_ERROR;
  }

  // Read previous state to get thread_id and working_dir
  let prevState;
  try {
    prevState = readState(resolvedSessionDir);
  } catch (e) {
    process.stderr.write(`Error: cannot read state.json: ${e.message}\n`);
    return EXIT_ERROR;
  }

  const threadId = prevState.thread_id || "";
  const resolvedWorkingDir = prevState.working_dir || "";
  const sessionId = prevState.session_id || path.basename(resolvedSessionDir);

  if (!threadId) {
    process.stderr.write("Error: no thread_id found in state.json — cannot resume\n");
    return EXIT_ERROR;
  }

  if (!resolvedWorkingDir) {
    process.stderr.write("Error: no working_dir found in state.json\n");
    return EXIT_ERROR;
  }

  // Check codex in PATH
  const whichCmd = IS_WIN ? "where" : "which";
  const probe = spawnSync(whichCmd, ["codex"], { encoding: "utf8" });
  if (probe.status !== 0) {
    process.stderr.write("Error: codex CLI not found in PATH\n");
    return EXIT_CODEX_NOT_FOUND;
  }

  // Read prompt from stdin (BEFORE clearing old artifacts — if stdin empty, abort without data loss)
  const prompt = readStdinSync();
  if (!prompt.trim()) {
    process.stderr.write("Error: no prompt provided on stdin\n");
    return EXIT_ERROR;
  }

  // Write prompt (overwrite)
  fs.writeFileSync(path.join(resolvedSessionDir, "prompt.txt"), prompt, "utf8");

  // Track for rollback
  let codexPgid = null;
  let watchdogPid = null;

  function startupCleanup() {
    if (codexPgid !== null) {
      killTree(codexPgid);
    }
    if (watchdogPid !== null && isAlive(watchdogPid)) {
      killSingle(watchdogPid);
    }
    // Session mode: do NOT delete session dir on startup failure
  }

  try {
    // Launch Codex WITH thread_id for resume
    const { pid: codexPid, pgid } = launchCodex(
      resolvedSessionDir, resolvedWorkingDir, timeout, threadId, effort,
    );
    codexPgid = pgid;

    // Launch watchdog
    watchdogPid = launchWatchdog(timeout, codexPgid);

    // Write state.json atomically (overwrite, preserve thread_id)
    const now = Math.floor(Date.now() / 1000);
    const state = {
      session_id: sessionId,
      pid: codexPid,
      pgid: codexPgid,
      watchdog_pid: watchdogPid,
      state_dir: resolvedSessionDir,
      working_dir: resolvedWorkingDir,
      effort,
      sandbox: prevState.sandbox || "read-only",
      timeout,
      started_at: now,
      thread_id: threadId,
      last_line_count: 0,
      stall_count: 0,
      last_poll_at: 0,
    };
    atomicWrite(path.join(resolvedSessionDir, "state.json"), JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    startupCleanup();
    return EXIT_ERROR;
  }

  // Success — now clear stale artifacts from previous round (after spawn confirmed)
  try { fs.unlinkSync(path.join(resolvedSessionDir, "final.txt")); } catch {}
  try { fs.unlinkSync(path.join(resolvedSessionDir, "review.md")); } catch {}

  process.stdout.write(`CODEX_STARTED:${resolvedSessionDir}\n`);
  return EXIT_SUCCESS;
}

function cmdPoll(argv) {
  const stateDirArg = argv[0];
  if (!stateDirArg) {
    process.stdout.write("POLL:failed:0s:1:Invalid or missing state directory\n");
    return EXIT_ERROR;
  }

  const { dir: stateDir, err } = validateStateDir(stateDirArg);
  if (err) {
    process.stdout.write(`POLL:failed:0s:1:${err}\n`);
    return EXIT_ERROR;
  }

  // Check for cached final result
  const finalFile = path.join(stateDir, "final.txt");
  if (fs.existsSync(finalFile)) {
    const cached = fs.readFileSync(finalFile, "utf8");
    process.stdout.write(cached);
    if (!cached.endsWith("\n")) process.stdout.write("\n");
    const reviewFile = path.join(stateDir, "review.md");
    const legacyReviewFile = path.join(stateDir, "review.txt");
    if (fs.existsSync(reviewFile)) {
      process.stderr.write(`[cached] Review available in ${stateDir}/review.md\n`);
    } else if (fs.existsSync(legacyReviewFile)) {
      // Migrate legacy v9 review.txt → review.md for automation compatibility
      try {
        const legacyContent = fs.readFileSync(legacyReviewFile, "utf8");
        atomicWrite(reviewFile, legacyContent);
        process.stderr.write(`[cached] Migrated legacy review.txt → review.md in ${stateDir}\n`);
      } catch {
        process.stderr.write(`[cached] Review available in ${stateDir}/review.txt (legacy v9 state)\n`);
      }
    }
    return EXIT_SUCCESS;
  }

  // Read state
  const state = readState(stateDir);
  const codexPid = state.pid || 0;
  const codexPgid = state.pgid || 0;
  const watchdogPid = state.watchdog_pid || 0;
  const timeoutVal = state.timeout || 3600;
  const startedAt = state.started_at || Math.floor(Date.now() / 1000);
  const lastLineCount = state.last_line_count || 0;
  const stallCount = state.stall_count || 0;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - startedAt;

  // Check if process is alive
  const processAlive = isAlive(codexPid);

  // Count lines
  const jsonlFile = path.join(stateDir, "output.jsonl");
  let currentLineCount = 0;
  if (fs.existsSync(jsonlFile)) {
    const content = fs.readFileSync(jsonlFile, "utf8");
    currentLineCount = content.split("\n").filter((l) => l.trim()).length;
  }

  // Stall detection
  const newStallCount = currentLineCount === lastLineCount
    ? stallCount + 1
    : 0;

  // Parse JSONL
  let { stdoutOutput: pollOutput, stderrLines, summary, extractedThreadId } = parseJsonl(
    stateDir, lastLineCount, elapsed, processAlive, timeoutVal, state
  );

  // Print progress to stderr
  for (const line of stderrLines) {
    process.stderr.write(line + "\n");
  }

  // Determine poll status from first line
  const firstLine = pollOutput.split("\n")[0] || "";
  const parts = firstLine.split(":");
  let pollStatus = parts.length >= 2 ? parts[1] : "";

  function writeFinalAndCleanup(content) {
    atomicWrite(path.join(stateDir, "final.txt"), content);
    verifyAndKillCodex(codexPid, codexPgid);
    if (watchdogPid) {
      verifyAndKillWatchdog(watchdogPid);
    }
  }

  if (pollStatus !== "running") {
    writeFinalAndCleanup(pollOutput);
  } else {
    // Check timeout/stall only when still running
    if (elapsed >= timeoutVal) {
      pollOutput = `POLL:timeout:${elapsed}s:${EXIT_TIMEOUT}:Timeout after ${timeoutVal}s`;
      writeFinalAndCleanup(pollOutput);
      pollStatus = "timeout";
    } else if (newStallCount >= 12 && processAlive) {
      pollOutput = `POLL:stalled:${elapsed}s:${EXIT_STALLED}:No new output for ~3 minutes`;
      writeFinalAndCleanup(pollOutput);
      pollStatus = "stalled";
    }
  }

  // Persist thread_id to state.json
  if (extractedThreadId) {
    updateState(stateDir, { thread_id: extractedThreadId });
  }

  // Update state.json
  updateState(stateDir, {
    last_line_count: currentLineCount,
    stall_count: newStallCount,
    last_poll_at: now,
  });

  // Append SUMMARY when still running
  if (pollStatus === "running") {
    pollOutput += `\nSUMMARY:${summary}`;
  }

  process.stdout.write(pollOutput + "\n");
  return EXIT_SUCCESS;
}

function cmdStop(argv) {
  const stateDirArg = argv[0];
  if (!stateDirArg) {
    process.stderr.write("Error: state directory argument required\n");
    return EXIT_ERROR;
  }

  const { dir: stateDir, err } = validateStateDir(stateDirArg);
  if (err) {
    process.stderr.write(`Error: ${err}\n`);
    return EXIT_ERROR;
  }

  // Read state and kill processes
  try {
    const state = readState(stateDir);
    const codexPid = state.pid || 0;
    const codexPgid = state.pgid || 0;
    const watchdogPid = state.watchdog_pid || 0;

    if (codexPid && codexPgid) {
      verifyAndKillCodex(codexPid, codexPgid);
    }
    if (watchdogPid) {
      verifyAndKillWatchdog(watchdogPid);
    }

    // Only delete in legacy runs/ mode
    if (state.run_id && !state.session_id) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    // Session mode: keep dir intact (kill processes only)
  } catch {
    // State may be corrupted, proceed to cleanup
  }

  return EXIT_SUCCESS;
}

function cmdWatchdog(argv) {
  const timeoutS = parseInt(argv[0], 10);
  const targetPid = parseInt(argv[1], 10);

  if (isNaN(timeoutS) || isNaN(targetPid)) {
    process.stderr.write("Error: _watchdog requires <timeout> <pid>\n");
    return EXIT_ERROR;
  }

  // Detach from parent session on Unix
  if (!IS_WIN) {
    try {
      process.setsid && process.setsid();
    } catch {
      // setsid may not be available in all Node.js builds
    }
  }

  // Use setTimeout to wait, then kill target
  setTimeout(() => {
    killTree(targetPid);
    process.exit(EXIT_SUCCESS);
  }, timeoutS * 1000);

  // Keep the process alive
  return -1; // Signal: don't exit immediately
}

// ============================================================
// CLI
// ============================================================

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || "";
  const rest = argv.slice(1);

  let exitCode;

  switch (command) {
    case "version":
      process.stdout.write(`${CODEX_RUNNER_VERSION}\n`);
      exitCode = EXIT_SUCCESS;
      break;
    case "init":
      exitCode = cmdInit(rest);
      break;
    case "start":
      exitCode = cmdStart(rest);
      break;
    case "resume":
      exitCode = cmdResume(rest);
      break;
    case "poll":
      exitCode = cmdPoll(rest);
      break;
    case "stop":
      exitCode = cmdStop(rest);
      break;
    case "_watchdog":
      exitCode = cmdWatchdog(rest);
      break;
    default:
      process.stderr.write(
        "codex-runner.js — Cross-platform runner for Codex CLI\n\n" +
        "Usage:\n" +
        "  node codex-runner.js version\n" +
        "  node codex-runner.js init --skill-name <name> --working-dir <dir>\n" +
        "  node codex-runner.js start <session_dir> [--effort <level>] [--timeout <s>] [--sandbox <mode>]\n" +
        "  node codex-runner.js resume <session_dir> [--effort <level>] [--timeout <s>]\n" +
        "  node codex-runner.js poll <state_dir>\n" +
        "  node codex-runner.js stop <state_dir>\n",
      );
      exitCode = command ? EXIT_ERROR : EXIT_SUCCESS;
      break;
  }

  // _watchdog returns -1 to keep process alive
  if (exitCode >= 0) {
    process.exit(exitCode);
  }
}

main();
