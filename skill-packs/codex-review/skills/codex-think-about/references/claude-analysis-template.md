# Claude Independent Analysis Format

Mirrors Codex's output-format.md for direct section-by-section comparison in Step 4.

```markdown
### Key Insights
- [insight] — Source: [URL or "own knowledge" or "project analysis"]
- ...

### Considerations
- [trade-off or risk] — Source: [URL or "own knowledge"]
- ...

### Recommendations
- [specific actionable recommendation]
- ...

### Sources
| # | URL | Description |
|---|-----|-------------|
| 1 | https://... | Description |
| 2 | (own knowledge) | Based on [reasoning] |

### Open Questions
- [what I'm uncertain about or want Codex's research to clarify]
- ...

### Confidence Level
- low | medium | high

### Suggested Status (advisory)
- CONTINUE | CONSENSUS | STALEMATE

### Strongest Positions
- [positions I'm most confident about — defend in debate]
```

**Notes:**
- Format mirrors Codex's `output-format.md` for easy comparison — all original sections preserved in same order.
- "Suggested Status" matches Codex's advisory field for symmetry.
- "Strongest Positions" is unique to Claude — marks which positions to defend vigorously.
- Sources "(own knowledge)" = Claude's training data; MCP-researched sources have URLs.
