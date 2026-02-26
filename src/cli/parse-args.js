const SUPPORTED_COMMANDS = new Set(["init", "doctor", "help"]);

export function parseArgs(argv) {
  const parsed = {
    command: "init",
    global: false,
    cwd: process.cwd(),
    dryRun: false,
    force: false,
    showVersion: false,
    showHelp: false
  };

  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    parsed.command = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "-g" || token === "--global") {
      parsed.global = true;
      continue;
    }

    if (token === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (token === "--force") {
      parsed.force = true;
      continue;
    }

    if (token === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --cwd");
      }
      parsed.cwd = value;
      index += 1;
      continue;
    }

    if (token === "-v" || token === "--version") {
      parsed.showVersion = true;
      continue;
    }

    if (token === "-h" || token === "--help") {
      parsed.showHelp = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (parsed.showHelp) {
    parsed.command = "help";
  }

  if (parsed.showVersion) {
    parsed.command = "version";
  }

  if (!SUPPORTED_COMMANDS.has(parsed.command) && parsed.command !== "version") {
    throw new Error(`Unknown command: ${parsed.command}`);
  }

  return parsed;
}
