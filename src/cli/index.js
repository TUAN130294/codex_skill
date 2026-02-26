import fs from "node:fs/promises";
import path from "node:path";

import { runDoctorCommand } from "../commands/doctor-command.js";
import { runInitCommand } from "../commands/init-command.js";
import { parseArgs } from "./parse-args.js";
import { resolvePackageRoot } from "../lib/paths.js";

function printHelp() {
  console.log(`codex-skill - install codex-review skill pack\n
Usage:
  codex-skill [init] [options]
  codex-skill doctor [options]
  codex-skill help

Commands:
  init        Install/update codex-review skill pack (default command)
  doctor      Validate codex CLI and skill installation health
  help        Show this help message

Options:
  -g, --global   Install/check at ~/.claude/skills (default: project scope)
  --cwd <path>   Project root for local install/check (default: current directory)
  --force        Replace existing installation
  --dry-run      Print what would happen without writing files
  -h, --help     Show help
  -v, --version  Show package version

Examples:
  codex-skill init
  codex-skill init -g
  codex-skill -g
  codex-skill doctor
`);
}

async function printVersion() {
  const packageRoot = resolvePackageRoot(import.meta.url);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  console.log(packageJson.version);
}

export async function runCli(argv) {
  try {
    const args = parseArgs(argv);

    if (args.command === "version") {
      await printVersion();
      return;
    }

    if (args.command === "help") {
      printHelp();
      return;
    }

    if (args.command === "doctor") {
      const ok = await runDoctorCommand(args);
      if (!ok) {
        process.exitCode = 1;
      }
      return;
    }

    await runInitCommand(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    console.error("Use `codex-skill --help` for usage.");
    process.exitCode = 1;
  }
}
