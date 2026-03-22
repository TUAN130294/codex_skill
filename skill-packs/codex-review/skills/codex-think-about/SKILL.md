---
name: codex-think-about
description: Peer debate between Claude Code and Codex on any technical question. Both sides think independently, challenge each other, and converge to consensus or explicit disagreement.
---

# Codex Think About

## Purpose
Use this skill for peer reasoning, not code review. Claude and Codex are equal analytical peers; Claude orchestrates the debate loop and final synthesis.

## When to Use
When you want to debate a technical decision or design question before implementing. Use this for architecture choices, technology comparisons, and reasoning through tradeoffs — not for code review.

## Prerequisites
- A question or decision topic from the user (may be vague — question-sharpening step will refine it).

## Runner

```bash
RUNNER="{{RUNNER_PATH}}"
SKILLS_DIR="{{SKILLS_DIR}}"
```

## Workflow
1. **Sharpen question** — follow `references/question-sharpening.md`.
   If that workflow produces a substantive rewrite, confirm with user (Y/n);
   otherwise proceed with the original question directly. The confirmed
   question (sharpened or original) becomes `{QUESTION}` for all subsequent
   steps (including Claude's own independent analysis and all Codex prompt rounds).
2. **Ask user** to choose reasoning effort level: `low`, `medium`, `high`, or `xhigh` (default: `high`). Gather factual context only (no premature opinion). Set `EFFORT`.
3. Render round-1 prompt: `echo '{"QUESTION":"...","PROJECT_CONTEXT":"...","RELEVANT_FILES":"...","CONSTRAINTS":"..."}' | node "$RUNNER" render --skill codex-think-about --template round1 --skills-dir "$SKILLS_DIR"`.
4. **Start Codex + Claude Independent Analysis (parallel)**:
   a. Start Codex thread: `node "$RUNNER" init --skill-name codex-think-about --working-dir "$PWD"` then pipe rendered prompt to `node "$RUNNER" start "$SESSION_DIR" --effort "$EFFORT" --sandbox danger-full-access`.
   b. **Claude Independent Analysis (IMMEDIATELY, before polling)**: Render Claude analysis prompt via `echo '{"QUESTION":"...","PROJECT_CONTEXT":"...","RELEVANT_FILES":"...","CONSTRAINTS":"..."}' | node "$RUNNER" render --skill codex-think-about --template claude-analysis --skills-dir "$SKILLS_DIR"`. Analyze the question independently using own knowledge and optionally MCP tools. Follow the rendered format. Complete this BEFORE reading any Codex output. See `references/workflow.md` Step 2.5.
   c. **INFORMATION BARRIER**: Do NOT read Codex's conclusions until Step 6. Poll activity telemetry (file reads, URLs, topics) is allowed for progress reporting.
5. Poll: `node "$RUNNER" poll "$SESSION_DIR"` — returns JSON with `status`, `review.insights`, `review.considerations`, `review.recommendations`, `review.suggested_status`, and `activities`. Report **specific activities** from the activities array. NEVER report generic "Codex is running" — always extract concrete details.
6. **Cross-Analysis**: After Codex completes, compare Claude's independent analysis with `review.insights`, `review.considerations`, `review.recommendations` from poll JSON. Identify genuine agreements, genuine disagreements, and unique perspectives. See `references/workflow.md` Step 4.
7. **Render round 2+ prompt**: `echo '{"AGREED_POINTS":"...","DISAGREED_POINTS":"...","NEW_PERSPECTIVES":"...","CONTINUE_OR_CONSENSUS_OR_STALEMATE":"..."}' | node "$RUNNER" render --skill codex-think-about --template round2+ --skills-dir "$SKILLS_DIR"`.
8. **Resume**: `echo "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --effort "$EFFORT"` → validate JSON. **Go back to step 5 (Poll).** Repeat steps 5→6→7→8 until consensus, stalemate, or hard cap (5 rounds).
9. **Finalize**: `echo '{"verdict":"...","scope":"think-about"}' | node "$RUNNER" finalize "$SESSION_DIR"`.
10. **Cleanup**: `node "$RUNNER" stop "$SESSION_DIR"`. Present user-facing synthesis with agreements, disagreements, cited sources, and confidence.

### Effort Level Guide
| Level    | Depth             | Best for                        | Typical time |
|----------|-------------------|---------------------------------|--------------|
| `low`    | Surface check     | Quick sanity check              | ~2-3 min     |
| `medium` | Standard review   | Most day-to-day work            | ~5-8 min     |
| `high`   | Deep analysis     | Important features              | ~10-15 min   |
| `xhigh`  | Exhaustive        | Critical/security-sensitive     | ~20-30 min   |

## Required References
- Question sharpening: `references/question-sharpening.md`
- Execution loop: `references/workflow.md`
- Prompt templates: `references/prompts.md`
- Output contract: `references/output-format.md`
- Claude analysis format: `references/claude-analysis-template.md`

## Rules
- Keep roles as peers; no reviewer/implementer framing.
- **Codex must NOT modify, create, or delete ANY project files.** `danger-full-access` sandbox is used SOLELY for web search. Prompt contains strict guardrails.
- Codex MUST cite sources (URL) for factual claims from web.
- Separate researched facts (with sources) from opinions.
- Detect stalemate when arguments repeat with no new evidence.
- End with clear recommendations, source list, and open questions.
- **Information barrier**: Claude MUST complete its independent analysis (Step 4b) before reading Codex output. This prevents anchoring bias.
- **Runner manages all session state** — do NOT manually read/write `rounds.json`, `meta.json`, or `prompt.txt` in the session directory.
