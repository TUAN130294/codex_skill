# Output Format Contract

Use this exact shape:

```markdown
### ISSUE-{N}: {Short title}
- Category: correctness | architecture | sequencing | risk | scope
- Severity: low | medium | high | critical
- Problem: {clear statement}
- Why it matters: {impact}
- Suggested fix: {plan-level change}

### VERDICT
- Status: APPROVE | REVISE
- Reason: {short reason}
```

If no issues remain, return only `VERDICT` with `Status: APPROVE`.
