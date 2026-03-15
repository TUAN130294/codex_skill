# Claude Independent Analysis Template

Use this exact format for Claude's independent PR analysis.

```markdown
### FINDING-{N}: {Short title}
- Category: bug | edge-case | security | performance | maintainability | pr-description | commit-hygiene | scope
- Severity: low | medium | high | critical
- File: {file path and line range, or "PR-level" for non-code findings}
- Problem: {clear statement}
- Evidence: {specific diff hunk, code reference, or PR metadata reference}
- Why it matters: {impact on correctness, security, maintainability, or merge readiness}

### Overall Assessment
- Code quality: poor | fair | good | excellent
- PR description accuracy: accurate | partially accurate | inaccurate | missing
- Commit hygiene: clean | acceptable | messy
- Scope appropriateness: focused | acceptable | too broad | too narrow

### Merge Readiness Pre-Assessment
- Must-pass criteria status: {for each: correctness(bug), security, edge-case(high+)}
- Blocking issues: {count of findings severity ≥ high in must-pass categories, or "none"}
- Initial recommendation: MERGE | REVISE | REJECT

### Strongest Positions
- {positions Claude is most confident about — defend these in debate}
```

If no findings, write only `Overall Assessment`, `Merge Readiness Pre-Assessment`, and `Strongest Positions`.

## FINDING-{N} vs ISSUE-{N}

Claude uses `FINDING-{N}` to distinguish from Codex's `ISSUE-{N}` during cross-analysis and final report. This prevents ID collisions in the mapping table.

## Matching Protocol (FINDING to ISSUE)

When cross-analyzing in Step 4, map Claude's FINDING-{N} with Codex's ISSUE-{N}:

1. **Semantic match**: Same Category + same file/diff area referenced = match. Wording does not need to be identical — only the same underlying problem.
2. **1-to-many**: If 1 FINDING maps to multiple ISSUEs (or vice versa), note the mapping explicitly (e.g., `FINDING-1 <> ISSUE-2, ISSUE-3`).
3. **Split/merge**: If Codex splits 1 issue into 2, or merges 2 into 1, record the new mapping and keep IDs stable. Do not renumber.
4. **Unmatched**: A FINDING or ISSUE with no counterpart is classified as "Claude-only" or "Codex-only".
5. **Mapping table**: Maintain one mapping table across all rounds. Each round updates the table — do not recreate from scratch.

```markdown
| Claude FINDING | Codex ISSUE | Classification | Status |
|---------------|-------------|----------------|--------|
| FINDING-1     | ISSUE-2     | Agreement      | Agreed |
| FINDING-2     | —           | Claude-only    | Pending |
| —             | ISSUE-1     | Codex-only     | Disputed |
```
