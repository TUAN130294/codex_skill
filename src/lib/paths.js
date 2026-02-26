import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePackageRoot(importMetaUrl) {
  const fromFile = fileURLToPath(importMetaUrl);
  return path.resolve(path.dirname(fromFile), "../..");
}

export function resolveSkillPackSource(packageRoot) {
  return path.join(packageRoot, "skill-packs", "codex-review");
}

export function resolveSkillsRoot({ global, cwd }) {
  if (global) {
    return path.join(os.homedir(), ".claude", "skills");
  }
  return path.join(path.resolve(cwd), ".claude", "skills");
}

export function resolveInstallPath({ global, cwd }) {
  const root = resolveSkillsRoot({ global, cwd });
  return path.join(root, "codex-review");
}
