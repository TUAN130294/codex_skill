"""embed-runner.py — Verifies version consistency across SKILL.md and hooks.json.

Checks that CODEX_RUNNER_VERSION from codex-runner.py matches all embed locations.
Usage:
    python embed-runner.py          # Check only (exit 1 if drift detected)
    python embed-runner.py --check  # Same as above
"""
import json
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)

SOURCE_FILE = os.path.join(PLUGIN_DIR, "scripts", "codex-runner.py")

def get_source_version():
    """Extract CODEX_RUNNER_VERSION from codex-runner.py."""
    # Run it directly
    for py in ["python3", "python", "py"]:
        try:
            result = subprocess.run(
                [py, SOURCE_FILE, "version"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip().isdigit():
                return result.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    # Fallback: parse the file
    with open(SOURCE_FILE) as f:
        for line in f:
            m = re.match(r"^CODEX_RUNNER_VERSION\s*=\s*(\d+)", line)
            if m:
                return m.group(1)
    return None


def check_skill_file(path, version):
    """Check if a SKILL.md file contains the correct version."""
    if not os.path.isfile(path):
        print(f"WARNING: Skill file not found: {path}", file=sys.stderr)
        return True  # not an error, just missing

    with open(path) as f:
        content = f.read()

    # Check for CODEX_RUNNER_VERSION = <version> (Python style)
    if f"CODEX_RUNNER_VERSION = {version}" in content:
        return True
    # Also check quoted grep style from bootstrap
    if f'"^{version}$"' in content:
        return True
    return False


def check_hooks_file(path):
    """Check if hooks.json contains a Python prerequisite check (v2.0+ pattern)."""
    if not os.path.isfile(path):
        print(f"WARNING: Hooks file not found: {path}", file=sys.stderr)
        return True

    with open(path) as f:
        data = json.load(f)

    hooks_val = data.get("hooks", {})
    if isinstance(hooks_val, dict):
        hook_groups = [g for groups in hooks_val.values() for g in groups]
    else:
        hook_groups = hooks_val

    for hook_group in hook_groups:
        for hook in hook_group.get("hooks", []):
            cmd = hook.get("command", "")
            # v2.0+: hooks.json checks for Python availability, not runner version
            if "python" in cmd.lower() and "codex-review" in cmd:
                return True
    return False


def main():
    if not os.path.isfile(SOURCE_FILE):
        print(f"ERROR: Source file not found: {SOURCE_FILE}", file=sys.stderr)
        return 1

    version = get_source_version()
    if not version:
        print("ERROR: Could not extract CODEX_RUNNER_VERSION from source file", file=sys.stderr)
        return 1

    print(f"Source: {SOURCE_FILE}")
    print(f"Version: {version}")

    errors = 0

    skill_files = [
        os.path.join(PLUGIN_DIR, "skills", "codex-plan-review", "SKILL.md"),
        os.path.join(PLUGIN_DIR, "skills", "codex-impl-review", "SKILL.md"),
        os.path.join(PLUGIN_DIR, "skills", "codex-think-about", "SKILL.md"),
    ]

    for skill_file in skill_files:
        if check_skill_file(skill_file, version):
            print(f"OK: {skill_file}")
        else:
            print(f"DRIFT: {skill_file} does not contain version {version}", file=sys.stderr)
            errors += 1

    hooks_file = os.path.join(PLUGIN_DIR, "hooks", "hooks.json")
    if check_hooks_file(hooks_file):
        print(f"OK: {hooks_file}")
    else:
        print(f"DRIFT: {hooks_file} missing Python prerequisite check", file=sys.stderr)
        errors += 1

    if errors > 0:
        print(f"\nFAILED: {errors} file(s) have version drift.", file=sys.stderr)
        return 1

    print("\nAll embeddings are in sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
