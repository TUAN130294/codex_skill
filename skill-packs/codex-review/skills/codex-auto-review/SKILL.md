---
name: codex-auto-review
description: Smart router that detects which review skills to run, executes them in parallel, and merges results into a unified report. Zero-friction comprehensive review with one command.
---

# Codex Auto Review

## Purpose
Meta-skill that analyzes the codebase/changes using rule-based detection, selects the most relevant review skills, runs them in parallel (or sequentially), and merges results into a unified report.

## Prerequisites
- Working directory with source code
- `codex` CLI is installed and authenticated
- `codex-review` skill pack is installed (`npx github:lploc94/codex_skill`)

## Runner

```bash
RUNNER="{{RUNNER_PATH}}"
```

## Workflow
1. **Collect inputs**: Ask user for scope (`working-tree` default / `branch` / `full`), effort level (`low` / `medium` / `high` default / `xhigh`), and execution mode (`parallel` default / `sequential`). Set `SCOPE`, `EFFORT`, `MODE`.
2. **Detect**: Run `node "$RUNNER" detect --working-dir "$PWD" --scope "$SCOPE"`. Parse JSON output and display detected skills with scores and reasons to user.
3. **Confirm**: Show final list of skills to run. User can add/remove skills. User confirms to proceed.
4. **Execute**: For each selected skill, read its prompt from `~/.claude/skills/<skill-name>/references/prompts.md`, fill variables, run single-round Codex review via `node "$RUNNER" start --working-dir "$PWD" --effort "$EFFORT"`. Run up to 3 in parallel (default). Poll all in round-robin until complete. See `references/workflow.md` for execution details.
5. **Merge & Report**: Read all `review.md` outputs. Deduplicate findings, sort by severity, tag by source skill, determine unified verdict. Write merged report. See `references/output-format.md` for report format.

### Effort Level Guide
| Level    | Depth             | Best for                        |
|----------|-------------------|---------------------------------|
| `low`    | Surface check     | Quick sanity check              |
| `medium` | Standard review   | Most day-to-day work            |
| `high`   | Deep analysis     | Important features              |
| `xhigh`  | Exhaustive        | Critical/security-sensitive     |

### Scope Guide
| Scope          | Coverage                           | Best for                    |
|----------------|------------------------------------|-----------------------------|
| `working-tree` | Uncommitted changes only           | Pre-commit review           |
| `branch`       | Branch diff vs base                | Pre-merge review            |
| `full`         | Entire codebase                    | Comprehensive audit         |

### Skills That Can Be Auto-Selected
| Skill | Delegatable | Notes |
|-------|-------------|-------|
| `codex-impl-review` | Yes | Standard review |
| `codex-security-review` | Yes | Security-focused review |
| `codex-commit-review` | Yes | Commit message review |
| `codex-pr-review` | Yes | PR review |
| `codex-plan-review` | Yes | Plan review |
| `codex-codebase-review` | **No** | Chunk workflow, suggest user run directly |
| `codex-think-about` | **No** | Not a review skill |
| `codex-parallel-review` | **No** | Meta-skill, would cause recursion |

## Required References
- Detailed execution + merge logic: `references/workflow.md`
- Prompt delegation instructions: `references/prompts.md`
- Unified report format: `references/output-format.md`

## Rules
- Single-round reviews only (no debate loops) for speed. Users can run individual skills for deep review.
- Codex reviews only; it does not edit files.
- If `codex-codebase-review` is detected (>50 source files), display recommendation to run it directly instead of delegating.
- If no skills meet the threshold, display message and suggest lowering threshold or running specific skills.
- If a parallel job fails (timeout/stall), continue other jobs and report partial results.
- Always report the unified verdict: any REVISE = overall REVISE, all APPROVE = overall APPROVE.
- On completion, report path to merged report and per-skill sub-reviews.
