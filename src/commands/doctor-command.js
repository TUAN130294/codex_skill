import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveInstallPath } from "../lib/paths.js";

function checkCodexCli() {
  const probe = process.platform === "win32"
    ? spawnSync("where", ["codex"], { encoding: "utf8" })
    : spawnSync("which", ["codex"], { encoding: "utf8" });

  return probe.status === 0;
}

function readManifest(targetDir) {
  const manifestPath = path.join(targetDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function checkInstall(targetDir) {
  const manifest = readManifest(targetDir);
  const expectedSkills = Array.isArray(manifest?.skills) ? manifest.skills : [];
  const missingSkills = [];
  const missingRunners = [];

  for (const skillName of expectedSkills) {
    const skillPath = path.join(targetDir, "skills", skillName, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      missingSkills.push(skillName);
    }

    const runnerPath = path.join(targetDir, "skills", skillName, "scripts", "codex-runner.sh");
    const resolverPath = path.join(targetDir, "skills", skillName, "scripts", "resolve-runner.sh");
    if (!fs.existsSync(runnerPath) || !fs.existsSync(resolverPath)) {
      missingRunners.push(skillName);
    }
  }

  const installed = fs.existsSync(targetDir);
  const hasRunner = missingRunners.length === 0 && expectedSkills.length > 0;
  const hasManifest = manifest !== null;
  const isHealthy = installed && hasRunner && hasManifest && missingSkills.length === 0;

  return {
    installed,
    hasRunner,
    hasManifest,
    missingSkills,
    missingRunners,
    expectedSkills,
    targetDir,
    isHealthy
  };
}

function statusMark(value) {
  return value ? "OK" : "MISSING";
}

function printScope(name, status) {
  console.log(`${name} install: ${statusMark(status.installed)} (${status.targetDir})`);
  console.log(`  manifest: ${statusMark(status.hasManifest)}`);
  if (status.expectedSkills.length === 0) {
    console.log("  runner scripts: MISSING");
  } else {
    console.log(`  runner scripts: ${status.missingRunners.length === 0 ? "OK" : status.missingRunners.join(", ")}`);
  }
  if (status.expectedSkills.length > 0) {
    const missing = status.missingSkills.length === 0 ? "none" : status.missingSkills.join(", ");
    console.log(`  missing skills: ${missing}`);
  }
}

export async function runDoctorCommand(options) {
  const hasCodex = checkCodexCli();
  console.log(`codex CLI: ${statusMark(hasCodex)}`);

  const scopes = options.global
    ? [{ name: "global", status: checkInstall(resolveInstallPath({ global: true, cwd: options.cwd })) }]
    : [
        { name: "global", status: checkInstall(resolveInstallPath({ global: true, cwd: options.cwd })) },
        { name: "local", status: checkInstall(resolveInstallPath({ global: false, cwd: options.cwd })) }
      ];

  for (const scope of scopes) {
    printScope(scope.name, scope.status);
  }

  if (!hasCodex) {
    console.log("Doctor result: FAIL");
    console.log("Hint: install Codex CLI and ensure `codex` is in PATH.");
    return false;
  }

  if (options.global) {
    const globalHealthy = scopes[0].status.isHealthy;
    if (!globalHealthy) {
      console.log("Doctor result: FAIL");
      console.log("Hint: run `codex-skill init -g --force`.");
      return false;
    }

    console.log("Doctor result: PASS");
    return true;
  }

  const healthyScopes = scopes.filter((scope) => scope.status.isHealthy);
  if (healthyScopes.length === 0) {
    console.log("Doctor result: FAIL");
    console.log("Hint: run `codex-skill init -g` or `codex-skill init` in your project.");
    return false;
  }

  if (healthyScopes.length === 2) {
    console.log("Doctor result: WARN (both global and local installs detected)");
    console.log("Hint: keep one scope to avoid ambiguity.");
    return true;
  }

  console.log("Doctor result: PASS");
  return true;
}
