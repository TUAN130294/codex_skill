import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function copyDirectoryAtomic({ sourceDir, destinationDir, force, dryRun }) {
  const destinationRoot = path.dirname(destinationDir);
  const tempDir = `${destinationDir}.tmp-${Date.now()}`;
  const backupDir = `${destinationDir}.backup-${Date.now()}`;

  await fs.mkdir(destinationRoot, { recursive: true });

  const destinationExists = await pathExists(destinationDir);
  if (destinationExists && !force) {
    throw new Error(
      `Target already exists: ${destinationDir}. Re-run with --force to replace it.`
    );
  }

  if (dryRun) {
    return {
      destinationExists,
      destinationDir,
      tempDir,
      backupDir,
      dryRun: true
    };
  }

  let backupCreated = false;
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.cp(sourceDir, tempDir, { recursive: true });

    if (destinationExists) {
      await fs.rename(destinationDir, backupDir);
      backupCreated = true;
    }

    await fs.rename(tempDir, destinationDir);

    if (backupCreated) {
      await fs.rm(backupDir, { recursive: true, force: true });
    }

    return {
      destinationExists,
      destinationDir,
      tempDir,
      backupDir,
      dryRun: false
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (backupCreated && !(await pathExists(destinationDir))) {
      await fs.rename(backupDir, destinationDir);
    }
    throw error;
  }
}

export async function ensureExecutableIfPresent(filePath) {
  if (process.platform === "win32") {
    return;
  }

  if (!(await pathExists(filePath))) {
    return;
  }

  await fs.chmod(filePath, 0o755);
}
