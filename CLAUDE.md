# CLAUDE.md

This repository now ships an npm CLI (`codex-skill`) that installs the `codex-review` skill pack into Claude skill directories.

## Project Overview

`codex-review` provides three skills powered by OpenAI Codex CLI:
- `/codex-plan-review` — debate plans before implementation
- `/codex-impl-review` — review uncommitted changes before commit
- `/codex-think-about` — peer reasoning/debate on technical topics

## Distribution Model

- Global scope install: `~/.claude/skills/codex-review`
- Project scope install: `<project>/.claude/skills/codex-review`
- Installed by `codex-skill init -g` or `codex-skill init`

No Claude plugin marketplace/hook packaging is used anymore.

## Requirements

- Node.js >= 20
- Claude Code CLI
- OpenAI Codex CLI in PATH (`codex`)
- OpenAI API key configured for Codex

## Development Commands

```bash
npm run check
node ./bin/codex-skill.js --help
node ./bin/codex-skill.js doctor
```

## Architecture

### CLI Layout

```text
bin/codex-skill.js
src/cli/
src/commands/
src/lib/
```

### Skill Pack Layout

```text
skill-packs/codex-review/
├── manifest.json
└── skills/
    ├── codex-plan-review/
    │   ├── SKILL.md
    │   ├── references/
    │   └── scripts/
    ├── codex-impl-review/
    │   ├── SKILL.md
    │   ├── references/
    │   └── scripts/
    └── codex-think-about/
        ├── SKILL.md
        ├── references/
        └── scripts/
```

## Design Principles

- Progressive disclosure: keep `SKILL.md` lean.
- Move long prompts/protocol details into `references/`.
- Keep deterministic logic in `scripts/`.
- Keep each skill self-contained; each skill owns its runner scripts.

## Verification

1. Run `node ./bin/codex-skill.js --help`
2. Run `node ./bin/codex-skill.js init --dry-run`
3. Run `node ./bin/codex-skill.js doctor`
4. Install skill pack and invoke skills inside Claude Code
