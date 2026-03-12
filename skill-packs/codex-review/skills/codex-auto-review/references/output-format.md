# Auto Review Output Format

## Unified Report Structure

The merged report follows this markdown format:

```markdown
# Auto Review Report

**Skills Run**: codex-impl-review, codex-security-review
**Scope**: working-tree
**Effort**: high
**Mode**: parallel
**Overall Verdict**: REVISE

---

## Critical (N)

### [security] ISSUE-1: SQL Injection in user query
- **File**: src/db/queries.ts:42
- **Severity**: critical
- **CWE**: CWE-89
- **OWASP**: A03:2021
- **Problem**: User input directly concatenated into SQL query string
- **Suggestion**: Use parameterized queries instead

### [impl] ISSUE-2: ...

---

## High (N)

### [impl] ISSUE-3: Null dereference in auth handler
- **File**: src/auth/handler.ts:88
- **Severity**: high
- **Problem**: ...
- **Suggestion**: ...

---

## Medium (N)

...

---

## Low (N)

...

---

## Summary

| Skill | Findings | Verdict |
|-------|----------|---------|
| codex-impl-review | 5 issues | REVISE |
| codex-security-review | 3 issues | APPROVE |
| **Total** | **8 issues (2 duplicates removed)** | **REVISE** |

## Duplicates Removed

| Kept | Removed (duplicate) | Reason |
|------|---------------------|--------|
| [security] ISSUE-1 | [impl] ISSUE-5 | Same file, same SQL injection issue |

## Session Info

- **Session directory**: .codex-review/auto-runs/<timestamp>/
- **Duration**: 2m 34s
- **Individual reports**: sub-reviews/<skill-name>/review.md
```

## Finding Format

Each finding in the merged report includes:

| Field | Required | Description |
|-------|----------|-------------|
| Source tag | Yes | `[security]`, `[impl]`, `[commit]`, `[pr]`, `[plan]` |
| Issue number | Yes | Sequential across merged report |
| Title | Yes | Short description |
| File | Yes | File path and line number |
| Severity | Yes | `critical`, `high`, `medium`, `low` |
| CWE | If security | CWE identifier |
| OWASP | If security | OWASP Top 10 category |
| Problem | Yes | What's wrong |
| Suggestion | Yes | How to fix |

## Verdict Rules

| Condition | Overall Verdict |
|-----------|----------------|
| Any skill says REVISE | REVISE |
| All skills say APPROVE | APPROVE |
| Mixed with stalemate | REVISE (note stalemate items) |
| Skill failed (timeout/error) | REVISE (note incomplete review) |

## Severity Ordering

Findings are grouped and ordered by severity:
1. **Critical** - Must fix before merge
2. **High** - Should fix before merge
3. **Medium** - Consider fixing
4. **Low** - Nice to have

Within each severity group, findings are ordered by source skill (alphabetical).

## Deduplication Rules

Two findings are considered duplicates when:
1. They reference the **same file** (exact path match)
2. They describe the **same problem** (fuzzy match by LLM judgment)

When duplicates are found:
- Keep the finding with **more detail** (longer problem description, has CWE/OWASP, has suggestion)
- Record the duplicate in the "Duplicates Removed" table
- Re-number remaining findings sequentially
