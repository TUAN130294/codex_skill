#!/usr/bin/env node

/**
 * E2E Stall Recovery Test
 *
 * Simulates a Codex stall scenario and verifies:
 * 1. Stall detection with configurable threshold
 * 2. Partial output recovery
 * 3. `recoverable` flag
 * 4. `--recovery` flag increments stall_recovery_count
 * 5. Auto-reduced stall_threshold on recovery
 * 6. Second stall → recoverable === false
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RUNNER = path.resolve("skill-packs/codex-review/scripts/codex-runner.js");
const NODE = process.execPath;

let dummyProcs = [];
let sessionDir = null;

function cleanup() {
  for (const p of dummyProcs) {
    try { process.kill(p.pid, "SIGKILL"); } catch {}
  }
  if (sessionDir && fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

function run(cmd, args, stdin = "") {
  const result = execFileSync(NODE, [RUNNER, cmd, ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 15000,
  });
  return result.trim();
}

function runJson(cmd, args, stdin = "") {
  const raw = run(cmd, args, stdin);
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
}

function spawnDummy() {
  const p = spawn(NODE, ["-e", "setInterval(()=>{},1<<30)"], {
    detached: true,
    stdio: "ignore",
  });
  p.unref();
  dummyProcs.push(p);
  return p.pid;
}

function writeJsonl(dir, lines) {
  const content = lines.map(l => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "output.jsonl"), content, "utf8");
}

function assert(condition, msg) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    cleanup();
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=== E2E Stall Recovery Test ===\n");

  // Step a: Init session
  console.log("Step a: Init session");
  const initOutput = run("init", ["--skill-name", "codex-think-about", "--working-dir", process.cwd()]);
  assert(initOutput.startsWith("CODEX_SESSION:"), "init returns CODEX_SESSION prefix");
  sessionDir = initOutput.replace("CODEX_SESSION:", "");
  console.log(`  Session: ${sessionDir}\n`);

  // Step b: Start with stall-threshold=5 (low for testing) + dummy process
  console.log("Step b: Start with dummy process + low stall threshold");
  const startResult = runJson("start", [sessionDir, "--stall-threshold", "5", "--effort", "low", "--timeout", "300"], "Test prompt for stall simulation");
  assert(startResult.status === "started", `start status = ${startResult.status}`);
  assert(startResult.round === 1, `round = ${startResult.round}`);

  // Replace the real codex PID with dummy process
  // First kill the real Codex process to prevent it from writing to output.jsonl
  const dummyPid1 = spawnDummy();
  const state1 = readState(sessionDir);
  const realPid = state1.pid;
  const realPgid = state1.pgid;
  const realWatchdog = state1.watchdog_pid;
  try { process.kill(-realPgid, "SIGKILL"); } catch {}
  try { process.kill(realPid, "SIGKILL"); } catch {}
  try { if (realWatchdog) process.kill(realWatchdog, "SIGKILL"); } catch {}
  // Wait a moment for the process to die
  await sleep(500);

  state1.pid = dummyPid1;
  state1.pgid = dummyPid1;
  fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify(state1, null, 2));

  assert(state1.stall_threshold === 5, `stall_threshold persisted = ${state1.stall_threshold}`);
  assert(state1.stall_recovery_count === 0, `stall_recovery_count = ${state1.stall_recovery_count}`);
  console.log();

  // Step c: Write JSONL with thread.started + 2 command_execution events (simulating DNS failures)
  console.log("Step c: Write JSONL simulating DNS failures");
  // Truncate any existing output.jsonl from real Codex before writing fake data
  const jsonlPath = path.join(sessionDir, "output.jsonl");
  try { fs.writeFileSync(jsonlPath, "", "utf8"); } catch {}
  const threadId = "thread_test_" + Date.now();
  writeJsonl(sessionDir, [
    { type: "thread.started", thread_id: threadId },
    { type: "item.started", item: { type: "command_execution", command: "curl -sS https://example.com" } },
    { type: "item.completed", item: { type: "command_execution", command: "curl -sS https://example.com", output: "" } },
    { type: "item.started", item: { type: "command_execution", command: "curl -sS https://example2.com" } },
    { type: "item.completed", item: { type: "command_execution", command: "curl -sS https://example2.com", output: "" } },
  ]);
  console.log();

  // Step d: Poll repeatedly until stall detected (threshold=5, so ~6 polls with no new output)
  console.log("Step d: Poll until stall detected");
  let pollResult;
  let pollCount = 0;

  for (let i = 0; i < 10; i++) {
    pollResult = runJson("poll", [sessionDir]);
    pollCount++;
    console.log(`  Poll ${pollCount}: status=${pollResult.status}`);

    if (pollResult.status === "stalled") break;

    // Small delay between polls
    await sleep(200);
  }

  // Step e: Verify stall detection
  console.log("\nStep e: Verify stall detection");
  assert(pollResult.status === "stalled", `status === "stalled" (got: ${pollResult.status})`);
  assert(pollResult.recoverable === true, `recoverable === true (got: ${pollResult.recoverable})`);
  assert(pollResult.exit_code === 4, `exit_code === 4 (got: ${pollResult.exit_code})`);
  assert(typeof pollResult.error === "string" && pollResult.error.includes("No new output"), `error contains "No new output"`);

  const stateAfterStall = readState(sessionDir);
  console.log(`  state.thread_id = ${JSON.stringify(stateAfterStall.thread_id)}, expected = ${JSON.stringify(threadId)}`);
  assert(stateAfterStall.stall_recovery_count === 0, `stall_recovery_count still 0 after stall`);
  assert(stateAfterStall.thread_id === threadId, `thread_id preserved = ${threadId}`);
  console.log();

  // Step f: Kill dummy process, stop, then resume --recovery
  console.log("Step f: Stop + resume with --recovery");
  try { process.kill(dummyPid1, "SIGKILL"); } catch {}

  const stopResult = runJson("stop", [sessionDir]);
  console.log(`  stop: status=${stopResult.status}`);

  // Spawn new dummy process for recovery round
  const dummyPid2 = spawnDummy();

  const resumeResult = runJson("resume", [sessionDir, "--recovery", "--stall-threshold", "5"], "Recovery prompt: continue analysis without web fetches");
  assert(resumeResult.status === "started", `resume status = ${resumeResult.status}`);
  assert(resumeResult.round === 2, `round = ${resumeResult.round}`);

  // Replace PID again
  const state2 = readState(sessionDir);
  state2.pid = dummyPid2;
  state2.pgid = dummyPid2;
  fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify(state2, null, 2));
  console.log();

  // Step g: Verify recovery state
  console.log("Step g: Verify recovery state");
  const stateAfterResume = readState(sessionDir);
  assert(stateAfterResume.stall_recovery_count === 1, `stall_recovery_count = ${stateAfterResume.stall_recovery_count}`);
  assert(stateAfterResume.stall_threshold <= 5, `stall_threshold auto-reduced to ${stateAfterResume.stall_threshold}`);
  console.log();

  // Step h: Trigger second stall → verify recoverable === false
  console.log("Step h: Second stall → recoverable === false");

  // Write minimal JSONL for round 2 (same thread, stall again)
  writeJsonl(sessionDir, [
    { type: "thread.started", thread_id: threadId },
    { type: "item.started", item: { type: "command_execution", command: "analyzing..." } },
    { type: "item.completed", item: { type: "command_execution", command: "analyzing...", output: "partial" } },
  ]);

  let pollResult2;
  let pollCount2 = 0;

  for (let i = 0; i < 10; i++) {
    pollResult2 = runJson("poll", [sessionDir]);
    pollCount2++;
    console.log(`  Poll ${pollCount2}: status=${pollResult2.status}`);

    if (pollResult2.status === "stalled") break;
    await sleep(200);
  }

  assert(pollResult2.status === "stalled", `second stall detected`);
  assert(pollResult2.recoverable === false, `recoverable === false (got: ${pollResult2.recoverable})`);
  console.log();

  // Step i: Cleanup
  console.log("Step i: Cleanup");
  try { process.kill(dummyPid2, "SIGKILL"); } catch {}
  runJson("stop", [sessionDir]);

  console.log("\n=== ALL TESTS PASSED ===");
  cleanup();
}

main().catch(e => {
  console.error("Test error:", e.message);
  cleanup();
  process.exit(1);
});
