# Auto Review Prompts

## Prompt Delegation Strategy

Auto-review delegates to existing skills by reading their actual prompt templates at runtime. This avoids duplicating prompts.

### How to Read Skill Prompts

For each selected skill, read its prompt template from the installed skill directory:

```
~/.claude/skills/<skill-name>/references/prompts.md
```

Fill in the template variables based on the current context:
- Working directory path
- Diff content (if applicable)
- File list
- Plan file path (for plan-review)
- Commit messages (for commit-review)
- PR description (for pr-review)

Use only the **Round 1 prompt** from each skill's prompts.md. Auto-review runs single-round reviews -- no debate loops.

### Fallback Prompt

If a skill's `references/prompts.md` cannot be read (file missing or permission error), use this fallback:

```
Review the following code changes for issues related to [SKILL_FOCUS]:

Working directory: [WORKING_DIR]
Scope: [SCOPE]

[DIFF_OR_FILE_CONTENT]

Provide findings in ISSUE-{N} format:

ISSUE-1
file: <path>
severity: <critical|high|medium|low>
title: <short description>
problem: <what's wrong>
suggestion: <how to fix>

End with a VERDICT block:
VERDICT: APPROVE | REVISE
REASON: <explanation>
```

Where `[SKILL_FOCUS]` maps to:
- `codex-impl-review` -> "correctness, edge cases, and code quality"
- `codex-security-review` -> "security vulnerabilities, OWASP Top 10, and CWE patterns"
- `codex-commit-review` -> "commit message clarity, conventions, and accuracy"
- `codex-pr-review` -> "PR quality, commit hygiene, and description accuracy"
- `codex-plan-review` -> "implementation plan completeness, risks, and feasibility"

## Merge Prompt

After all skill reviews complete, use this prompt to merge results:

```
You have collected review outputs from multiple Codex review skills.
Your task is to merge them into a single unified report.

Skills that ran: [SKILL_LIST]

For each skill's output below, parse all ISSUE-{N} blocks and VERDICT blocks.

[SKILL_1_NAME] output:
---
[SKILL_1_OUTPUT]
---

[SKILL_2_NAME] output:
---
[SKILL_2_OUTPUT]
---

Merge rules:
1. DEDUPLICATE: If two findings refer to the same file and same problem, keep the more detailed one. Note the duplicate.
2. SORT by severity: critical > high > medium > low
3. TAG each finding with its source skill: [security], [impl], [commit], [pr], [plan]
4. UNIFIED VERDICT: Any REVISE = overall REVISE. All APPROVE = overall APPROVE.
5. SUMMARY TABLE: Show per-skill finding count and verdict.

Write the merged report in the format specified in output-format.md.
```
