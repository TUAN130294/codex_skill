# codex-skill

`codex-skill` is an npm CLI that installs the `codex-review` skill pack for Claude Code.

The pack provides three skills:
- `/codex-plan-review`
- `/codex-impl-review`
- `/codex-think-about`

## Requirements

- Node.js >= 20
- Claude Code CLI
- OpenAI Codex CLI (`codex`) in PATH
- OpenAI API key configured for Codex

## Install

### Global scope

```bash
npm install -g codex-skill
codex-skill init -g
```

Global install target:
- `~/.claude/skills/codex-review`

### Project scope

```bash
npx codex-skill init
```

Project install target:
- `<project>/.claude/skills/codex-review`

## Verify

```bash
codex-skill doctor
```

## Usage

After install, start Claude Code and run:
- `/codex-plan-review` to debate implementation plans before coding.
- `/codex-impl-review` to review uncommitted changes before commit.
- `/codex-think-about` for peer reasoning with Codex.

## CLI Reference

```bash
codex-skill [init] [options]
codex-skill doctor [options]
```

Options:
- `-g, --global`: global scope (`~/.claude/skills`)
- `--cwd <path>`: project root for local scope
- `--force`: replace existing install
- `--dry-run`: print actions without writing
- `-h, --help`: help
- `-v, --version`: version

## Project Structure

```text
.
├── bin/
│   └── codex-skill.js
├── src/
│   ├── cli/
│   ├── commands/
│   └── lib/
├── skill-packs/
│   └── codex-review/
│       ├── manifest.json
│       └── skills/
│           ├── codex-plan-review/
│           │   ├── SKILL.md
│           │   ├── references/
│           │   └── scripts/
│           ├── codex-impl-review/
│           │   ├── SKILL.md
│           │   ├── references/
│           │   └── scripts/
│           └── codex-think-about/
│               ├── SKILL.md
│               ├── references/
│               └── scripts/
├── CLAUDE.md
└── package.json
```

## License

MIT
