# Question Sharpening

Run this step before collecting effort level. Its output becomes `{QUESTION}`
for all downstream prompt assembly (workflow.md step 2b onward, including
Claude's independent analysis at step 2.5).

Claude holds the confirmed sharpened question in context — no file write needed.

---

## Evaluation Criteria

Evaluate the user's question against all three criteria:

| Criterion | Vague | Sharp |
|-----------|-------|-------|
| **Specificity** — clear options or decision to analyze | "which database?" | "PostgreSQL vs MongoDB for write-heavy 10k req/s?" |
| **Context** — stack/team/constraints stated or inferable | "use microservices?" | "3-person team, Node.js monolith — migrate to microservices?" |
| **Debatability** — genuinely two-sided, not a factual lookup | "is Redis faster than disk?" | "use Redis as primary session store?" |

---

## Decision Tree

```
Question received
    │
    ├─ All 3 criteria met
    │   If rewrite would be substantively identical to the input (cosmetic
    │   restructuring only) → skip confirm, proceed with user's original
    │   question directly.
    │   Otherwise → Rewrite → Show → Confirm Y/n → [see Decline Path]
    │
    ├─ 1–2 criteria missing but inferable from codebase
    │   Inspect (one pass, no iteration): top-level directory listing +
    │   package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml,
    │   docker-compose.yml, .env.example (whichever exist).
    │   • No codebase present (empty or non-project dir) → treat as "too vague"
    │   • Scan yields zero signals for missing criterion → treat as "too vague"
    │   • Ambiguous signals (e.g. both Redis and Memcached) → list ambiguity
    │     in "Inferred context:" field, do not choose one silently
    │   → Infer missing parts → Rewrite → Show → Confirm Y/n → [see Decline Path]
    │
    └─ Too vague to infer
        → Ask clarifying questions one at a time (max 2 total).
          After each answer, re-evaluate criteria.
          If criteria now met → rewrite immediately, skip remaining questions.
        → Rewrite → Show → Confirm Y/n → [see Decline Path]
```

---

## Decline Path

Applies after any branch reaches "Confirm Y/n":

1. User says **Y** → confirmed question is locked as `{QUESTION}`. Proceed to effort level.
2. User says **N** → ask one open-ended follow-up: *"What would you like to change?"*
3. Revise the rewrite using the answer. Re-present for confirmation.
4. User says **N** again → proceed with the current best-effort rewrite and note
   the user chose not to refine further. No third confirmation round.

---

## Output Templates

**Comparison template** — use only when user explicitly names two concrete options:

```
📋 Sharpened question:
   "Should we use [A] or [B] for [specific use case],
    given [stack / team size / scale constraints]?
    Decision criteria: [performance / cost / maintainability / ...]"

Inferred context: [what Claude added from codebase, or "none"]
Proceed with this question? (Y/n)
```

**Open reasoning template** — use for all other cases; default when type is unclear:

```
📋 Sharpened question:
   "[Decision or question] in the context of [stack / constraints],
    considering [key criteria or trade-offs]."

Inferred context: [what Claude added from codebase, or "none"]
Proceed with this question? (Y/n)
```

Respond in the same language the user used.

---

## Examples

**Example 1 — Context missing, inferable**

User: "what should we use for caching?"
Inspection: docker-compose.yml has Redis; package.json shows Node.js.
Zero concrete options named → open reasoning template.

> 📋 Sharpened question:
>    "Should we introduce a dedicated caching layer for the Node.js API, given
>     Redis is already in the stack? Considering: latency reduction, operational
>     complexity, and whether Redis alone suffices vs. adding an in-process cache."
>
> Inferred context: Redis from docker-compose.yml, Node.js from package.json.
> Proceed with this question? (Y/n)

---

**Example 2 — Two options named, context inferable**

User: "PostgreSQL vs MongoDB for our project?"
Inspection: fixtures/ shows document-heavy schema; package.json shows Node.js.
Two options named → comparison template.

> 📋 Sharpened question:
>    "Should we use PostgreSQL or MongoDB as the primary data store,
>     given a document-heavy data model and a Node.js API?
>     Decision criteria: query flexibility, schema evolution, operational complexity."
>
> Inferred context: document-heavy model from fixtures/, Node.js from package.json.
> Proceed with this question? (Y/n)

---

**Example 3 — All criteria met, direct rewrite**

User: "should we adopt event sourcing for our order service, given we already
have CQRS and a 5-person team familiar with DDD?"
All criteria explicit → open reasoning template.

> 📋 Sharpened question:
>    "Should the order service adopt event sourcing, given an existing CQRS
>     architecture and a 5-person team with DDD experience?
>     Considering: audit trail requirements, operational overhead, team ramp-up."
>
> Inferred context: none.
> Proceed with this question? (Y/n)

---

**Example 4 — Too vague, one question sufficient**

User: "monolith vs microservices?"
Q1: "Are you starting a new project or migrating an existing system?"
Answer: "migrating a Node.js monolith, 3-person team."
Re-evaluate: all criteria met (two options named: monolith vs microservices;
context: Node.js, 3-person team; debatability: yes) → rewrite immediately, skip Q2.
Two concrete options named → comparison template.

> 📋 Sharpened question:
>    "Should we migrate the existing Node.js monolith to microservices,
>     given a 3-person team?
>     Decision criteria: deployment complexity, team cognitive load, scalability."
>
> Inferred context: none (provided by user).
> Proceed with this question? (Y/n)

---

**Example 5 — Too vague, two questions needed**

User: "best database for our app?"
Q1: "What kind of data — relational, document, or time-series?"
Answer: "relational, financial transactions."
Re-evaluate: specificity still missing (no concrete options). Ask Q2.
Q2: "Are you considering specific databases, or open to any recommendation?"
Answer: "comparing PostgreSQL vs MySQL."
Re-evaluate: all criteria met. Two options named → comparison template.

> 📋 Sharpened question:
>    "Should we use PostgreSQL or MySQL as the primary database
>     for financial transaction data?
>     Decision criteria: ACID compliance, ecosystem maturity, operational complexity."
>
> Inferred context: none (provided by user).
> Proceed with this question? (Y/n)
