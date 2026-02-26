import fs from "node:fs/promises";
import path from "node:path";

import { copyDirectoryAtomic, ensureExecutableIfPresent, pathExists } from "../lib/fs-utils.js";
import { resolveInstallPath, resolvePackageRoot, resolveSkillPackSource } from "../lib/paths.js";

export async function runInitCommand(options) {
  const packageRoot = resolvePackageRoot(import.meta.url);
  const sourceDir = resolveSkillPackSource(packageRoot);
  const targetDir = resolveInstallPath({ global: options.global, cwd: options.cwd });

  if (!(await pathExists(sourceDir))) {
    throw new Error(`Skill pack source not found: ${sourceDir}`);
  }

  console.log(`Source: ${sourceDir}`);
  console.log(`Target: ${targetDir}`);
  console.log(`Scope : ${options.global ? "global (~/.claude/skills)" : "project (./.claude/skills)"}`);

  const copyResult = await copyDirectoryAtomic({
    sourceDir,
    destinationDir: targetDir,
    force: options.force,
    dryRun: options.dryRun
  });

  if (copyResult.dryRun) {
    console.log("Dry-run mode: no files were written.");
    return;
  }

  const skillNames = [
    "codex-plan-review",
    "codex-impl-review",
    "codex-think-about"
  ];

  for (const skillName of skillNames) {
    const runnerPath = path.join(targetDir, "skills", skillName, "scripts", "codex-runner.sh");
    const resolveRunnerPath = path.join(
      targetDir,
      "skills",
      skillName,
      "scripts",
      "resolve-runner.sh"
    );
    await ensureExecutableIfPresent(runnerPath);
    await ensureExecutableIfPresent(resolveRunnerPath);
  }

  const manifestPath = path.join(targetDir, ".codex-skill-install.json");
  const manifest = {
    package: "codex-skill",
    installedAt: new Date().toISOString(),
    scope: options.global ? "global" : "project",
    targetDir
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (copyResult.destinationExists) {
    console.log("Updated existing installation.");
  } else {
    console.log("Installed codex-review skill pack.");
  }

  console.log(
    `Runners: ${skillNames.map((skillName) => `skills/${skillName}/scripts/codex-runner.sh`).join(", ")}`
  );
  console.log("Done. Run `codex-skill doctor` to verify environment health.");
}
