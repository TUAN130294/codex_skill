# codex-skill

Single-command installer for the **codex-review** skill pack for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Eight skills powered by [OpenAI Codex CLI](https://github.com/openai/codex):
- `/codex-plan-review` — debate implementation plans before coding
- `/codex-impl-review` — review uncommitted or branch changes before commit/merge
- `/codex-think-about` — peer reasoning/debate on technical topics
- `/codex-commit-review` — review commit messages for clarity and conventions
- `/codex-pr-review` — review PRs (branch diff, commit hygiene, description)
- `/codex-parallel-review` — parallel independent review by both Claude and Codex, then debate
- `/codex-codebase-review` — chunked full-codebase review for large projects (50-500+ files)
- `/codex-security-review` — security-focused review using OWASP Top 10 and CWE patterns

## Requirements

- Node.js >= 22
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`) in PATH
- OpenAI API key configured for Codex

## Install

### Basic Installation (Manual Invocation)
```bash
npx github:lploc94/codex_skill
```

### Auto-Review Mode (Automatic Triggers)
```bash
npx github:lploc94/codex_skill --auto
```

The `--auto` flag enables automatic review triggers by injecting guidance into your project's `CLAUDE.md`. Claude Code will automatically invoke review skills at appropriate times (before commits, PRs, when security-sensitive code is detected, etc.) without manual invocation.

### What it does
1. Installs 8 skills directly into `~/.claude/skills/` (one directory per skill)
2. Copies the shared `codex-runner.js` to `~/.claude/skills/codex-review/scripts/`
3. Injects the absolute runner path into each SKILL.md template
4. Validates templates and references before finalizing
5. Atomic swap per directory with rollback on failure
6. **With `--auto` flag**: Injects auto-review guidance into `CLAUDE.md` in the current directory

### Verify
```bash
node ~/.claude/skills/codex-review/scripts/codex-runner.js version
```

### Reinstall / Update
```bash
npx github:lploc94/codex_skill
# or with auto-review mode
npx github:lploc94/codex_skill --auto
```

## Usage

### Manual Invocation
After install, start Claude Code and run:
- `/codex-plan-review` to debate implementation plans before coding.
- `/codex-impl-review` to review uncommitted or branch changes before commit/merge.
- `/codex-think-about` for peer reasoning with Codex.
- `/codex-commit-review` to review commit messages.
- `/codex-pr-review` to review PRs (branch diff + description).
- `/codex-parallel-review` for parallel dual-reviewer analysis + debate.
- `/codex-codebase-review` for chunked full-codebase review (50-500+ files).
- `/codex-security-review` for security-focused review (OWASP Top 10 + CWE patterns).

### Auto-Review Mode
If you installed with `--auto` flag, Claude Code will automatically trigger reviews at appropriate times:
- **Before commits**: Runs `/codex-impl-review` when you ask to commit changes
- **Before PRs**: Runs `/codex-pr-review` when creating pull requests
- **Plan files**: Runs `/codex-plan-review` when plan documents are created/modified
- **Security-sensitive code**: Runs `/codex-security-review` for auth, SQL, crypto, user input
- **Comprehensive review**: Runs `/codex-auto-review` when explicitly requested

You can still manually invoke any skill even in auto-review mode.

## License

MIT
