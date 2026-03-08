# Output Format Contract

## Initial Review (Phase 1)

Use this exact shape:

```markdown
### ISSUE-{N}: {Short title}
- Category: bug | edge-case | security | performance | maintainability | architecture
- Subcategory: (for security) injection | broken-auth | sensitive-data | xxe | broken-access | security-config | xss | insecure-deserialization | logging | ssrf | crypto-failure | insecure-design | vulnerable-components | integrity-failure | rate-limiting | file-upload | secrets; (for performance) algorithmic | memory | io | database | caching | bundle
- Severity: low | medium | high | critical
- Confidence: high | medium | low (required for security findings)
- CWE: CWE-{ID} ({Name}) (required for security findings)
- OWASP: A{NN}:2021 - {Category Name} (required for security findings)
- Problem: {clear statement}
- Evidence: {where/how observed}
- Attack Vector: {how exploitable} (required for security findings)
- Suggested fix: {concrete fix path}

### VERDICT
- Status: APPROVE | REVISE
- Reason: {short reason}
```

## Debate Response (Phase 3)

For each disputed item, add response blocks before VERDICT:

```markdown
### RESPONSE-{N}: Re: {original finding title}
- Action: accept | reject | revise
- Reason: {evidence-based reasoning}

### VERDICT
- Status: APPROVE | REVISE
- Reason: {short reason}
```

If no issues remain, return only `VERDICT` with `Status: APPROVE`.
