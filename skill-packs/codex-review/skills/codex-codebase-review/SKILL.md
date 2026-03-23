---
name: codex-codebase-review
description: Review entire codebases (50-500+ files) by chunking into modules, reviewing each chunk in a separate Codex session, then synthesizing cross-cutting findings.
---

# Codex Codebase Review

## Purpose
Review large codebases (50-500+ files) that exceed single-session context limits. Splits codebase into module-based chunks, reviews each in an independent Codex session, then Claude synthesizes cross-cutting findings across modules.

## When to Use
For full codebase audit (50-500+ files). Not for incremental change review — use `/codex-impl-review` for that. Run periodically for architecture/quality sweeps or before major releases.

## Prerequisites
- Source files in working directory.

## Runner

```bash
RUNNER="{{RUNNER_PATH}}"
SKILLS_DIR="{{SKILLS_DIR}}"
json_esc() { printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(d)))'; }
```

## Stdin Format Rules
- **JSON** → `render`/`finalize`: heredoc. Literal-only → `<<'RENDER_EOF'`. Dynamic vars → escape with `json_esc`, use `<<RENDER_EOF` (unquoted).
- **json_esc output includes quotes** → embed directly: `{"KEY":$(json_esc "$VAL")}`.
- **Plain text** → `start`/`resume`: `printf '%s' "$PROMPT" | node "$RUNNER" ...` — NEVER `echo`.
- **NEVER** `echo '{...}'` for JSON. Forbidden: NULL bytes (`\x00`).

## Workflow

### 1. Collect Inputs

**Effort detection:**
```bash
FILE_COUNT=$(find . -type f \( -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.rb" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" \) | grep -v node_modules | grep -v .git | grep -v dist | grep -v build | grep -v vendor | grep -v __pycache__ | grep -v target | wc -l)
if [ "$FILE_COUNT" -lt 50 ]; then EFFORT="medium"
elif [ "$FILE_COUNT" -le 200 ]; then EFFORT="high"
else EFFORT="xhigh"
fi
```

Announce: `"Detected: effort=$EFFORT (N source files). Proceeding — reply to override."` Also ask: **parallel factor** (default 1, sequential; 2-3 for speed), **focus areas** (optional: security, performance, architecture, correctness, maintainability — default all). **Scope**: full codebase only — for diff review → `/codex-impl-review`.

**Effort levels** (inline reference):

| Level | Discovery | Cross-cutting | Validation | Time/chunk |
|-------|-----------|---------------|------------|------------|
| low | Auto-detect | Basic (2 cats) | Skip | ~10-20 min |
| medium | Auto+confirm | Standard (3) | Skip | ~15-30 min |
| high | Full+confirm | Full (5) | 1 round | ~20-40 min |
| xhigh | Full+suggest | Full+arch | 2 rounds | ~30-60 min |

### 2. Discovery

#### 2a) Detect Project Type

| Marker | Type | Source Roots |
|--------|------|-------------|
| `package.json` + `tsconfig.json` | TypeScript/Node | `src/`, `lib/`, `app/` |
| `package.json` (no tsconfig) | JavaScript/Node | `src/`, `lib/`, `app/` |
| `pyproject.toml` / `setup.py` | Python | `src/{pkg}/`, dirs with `__init__.py` |
| `go.mod` | Go | dirs containing `.go` files |
| `Cargo.toml` | Rust | `src/`, `crates/` |
| `pom.xml` / `build.gradle` | Java | `src/main/java/` |
| `*.csproj` | C# | `src/` |
| (none matched) | Generic | top-level dirs fallback |

#### 2b) List Source Files
```bash
find . -type f \( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" \
  -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.cs" \
  -o -name "*.rb" -o -name "*.php" -o -name "*.vue" -o -name "*.svelte" \) \
  | grep -v node_modules | grep -v .git | grep -v dist | grep -v build \
  | grep -v vendor | grep -v __pycache__ | grep -v target \
  | grep -v .next | grep -v .nuxt | grep -v coverage
```

#### 2c) Identify Module Boundaries
Group files by top-level directory under source root (depth 2). Example: `src/auth/` → module "auth", `src/api/` → module "api", standalone `src/index.ts` → module "root".

#### 2d) Count Lines Per Module
```bash
wc -l <files_in_module> | tail -1
```

#### 2e) Present Module Table
Display for confirmation (effort >= medium; `low` → skip, auto-proceed):
```
| # | Module | Files | Lines | Est. Chunks |
|---|--------|-------|-------|-------------|
| 1 | config | 3 | 150 | (merge) |
| 2 | auth | 12 | 1800 | 1 |
| **Total** | | **54** | **6620** | **5-6** |
```

### 3. Chunking

**Target**: 500-2000 lines per chunk. **Rules**: module < 300 lines → merge with related module; module > 2500 lines → split by sub-directory; ordering: config/types first → core/utils → features → tests last.

**Merge strategy**: Sort by line count ascending. Small modules (< 300 lines) merge with thematically related neighbor. Merged chunks ≤ 2000 lines. Standalone root files → nearest thematic chunk.

**Split strategy**: For modules > 2500 lines — group by immediate sub-directory. If still > 2500, split alphabetically into ~1500-line groups. Suffix names: `api-routes`, `api-middleware`, `api-controllers`.

**Present chunk plan** (effort >= medium; `low` → skip, auto-proceed):
```
| # | Chunk Name | Modules/Files | Lines | Order |
|---|-----------|---------------|-------|-------|
| 1 | config-types | config/, types/ | 380 | 1st |
| 2 | auth | auth/ | 1800 | 4th |
```

### 4. Review Loop

Track all sessions for cleanup:
```bash
ALL_SESSION_DIRS=()
```

#### Sequential Mode (parallel_factor=1)

For each chunk in order:

**4a) Init:**
```bash
INIT_OUTPUT=$(node "$RUNNER" init --skill-name codex-codebase-review --working-dir "$PWD")
CHUNK_SESSION_DIR=${INIT_OUTPUT#CODEX_SESSION:}
ALL_SESSION_DIRS+=("$CHUNK_SESSION_DIR")
```
Validate: `INIT_OUTPUT` must start with `CODEX_SESSION:`.

**4b) Render prompt** (template `chunk-review`):
```bash
PROMPT=$(node "$RUNNER" render --skill codex-codebase-review --template chunk-review --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"PROJECT_TYPE":$(json_esc "$PROJECT_TYPE"),"CHUNK_NAME":$(json_esc "$CHUNK_NAME"),"FOCUS_AREAS":$(json_esc "$FOCUS_AREAS"),"FILE_LIST":$(json_esc "$FILE_LIST"),"CONTEXT_SUMMARY":$(json_esc "$CONTEXT_SUMMARY")}
RENDER_EOF
)
```
Variables: `PROJECT_TYPE` from §2a, `CHUNK_NAME` (e.g. "auth"), `FOCUS_AREAS` (comma-separated or "all"), `FILE_LIST` (newline-separated files), `CONTEXT_SUMMARY` (high/critical from prior chunks; empty for first chunk).

**4c) Start:**
```bash
printf '%s' "$PROMPT" | node "$RUNNER" start "$CHUNK_SESSION_DIR" --effort "$EFFORT"
```
Validate JSON: `{"status":"started","round":1}`. Error with `CODEX_NOT_FOUND` → tell user to install codex.

**4d) Poll:**
```bash
POLL_JSON=$(node "$RUNNER" poll "$CHUNK_SESSION_DIR")
```
**Poll intervals**: 60s, 60s, 30s, 15s+.

Report **specific activities**: `"Chunk {N}/{TOTAL} [{name}] — Codex [{elapsed}s]: reading src/auth.js, analyzing auth flow"`. NEVER generic "Codex is running". Continue while `status === "running"`. Stop on `completed|failed|timeout|stalled`.

**4e) Parse results**: Issues from `poll_json.review.blocks[]` — each has `id`, `title`, `severity`, `category`, `location`, `problem`, `evidence`, `suggested_fix`. Verdict in `review.verdict.status`. Fallback: `review.raw_markdown`.

**4f) Context propagation**: After each chunk, extract high/critical findings: `- [{chunk_name}] {title}: {summary} ({severity}) in {file}`. Cap ~2000 tokens; newest replaces oldest.

**4g) Report progress**: `Chunk {N}/{TOTAL} [{name}]: {issue_count} issues ({C}C/{H}H/{M}M/{L}L)`.

**4h) Finalize chunk:**
```bash
node "$RUNNER" finalize "$CHUNK_SESSION_DIR" <<'FINALIZE_EOF'
{"verdict":"...","scope":"codebase"}
FINALIZE_EOF
```

**4i) Status** (optional): `node "$RUNNER" status "$CHUNK_SESSION_DIR"` — inspect any session without side effects.

#### Parallel Mode (parallel_factor=2-3)

**Batch formation**: Group chunks into batches of `parallel_factor` size. Example: 7 chunks, factor 2 → [1,2], [3,4], [5,6], [7].

**Per batch**: Start ALL chunks simultaneously (multiple init/render/start). Poll round-robin across active sessions. Context propagation BETWEEN batches only (not within). After batch complete → extract context → finalize each → next batch.

**Polling round-robin**: While any chunk running → poll each active session once → if completed/failed mark done, parse results → sleep (same adaptive schedule).

### 5. Cross-cutting Analysis (Claude-only)

After ALL chunks reviewed, Claude synthesizes findings.

**Categories by effort**: Pattern inconsistencies + DRY violations (all levels); API contract violations (medium+); integration concerns + architecture assessment (high+).

**Process**: Collect all ISSUE-{N} from all chunks → group by file/category/severity → look for cross-module patterns → generate CROSS-{N} findings.

**Examples**: Same validation logic in `auth/` and `api/middleware/`; model exports interface but route redefines inline; inconsistent error handling across modules; circular imports.

### 6. Validation (effort >= high)

**6a) Init:**
```bash
INIT_OUTPUT=$(node "$RUNNER" init --skill-name codex-codebase-review --working-dir "$PWD")
VALIDATION_SESSION_DIR=${INIT_OUTPUT#CODEX_SESSION:}
ALL_SESSION_DIRS+=("$VALIDATION_SESSION_DIR")
```

**6b) Render** (template `validation`):
```bash
PROMPT=$(node "$RUNNER" render --skill codex-codebase-review --template validation --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"CROSS_FINDINGS":$(json_esc "$CROSS_FINDINGS")}
RENDER_EOF
)
```

**6c) Start + Poll:**
```bash
printf '%s' "$PROMPT" | node "$RUNNER" start "$VALIDATION_SESSION_DIR" --effort "$EFFORT"
```
Poll with same adaptive intervals as §4d. Parse `review.blocks[]` — each has `prefix: "RESPONSE"`, `action` (`accept`/`reject`/`revise`), `reason`. Fallback: `review.raw_markdown`.

**6d) Rounds**: high → 1 round max; xhigh → up to 2 rounds.

**6e) Finalize:**
```bash
node "$RUNNER" finalize "$VALIDATION_SESSION_DIR" <<'FINALIZE_EOF'
{"verdict":"...","scope":"codebase"}
FINALIZE_EOF
```

### 7. Final Report

| Metric | Value |
|--------|-------|
| Project type | {type} |
| Total files | {N} |
| Total lines | {L} |
| Chunks reviewed | {C}/{TOTAL} |
| Total issues | {I} |
| Cross-cutting findings | {X} |

Present: per-module findings (ISSUE-{N} grouped by severity), cross-cutting findings (CROSS-{N} grouped by category), architecture assessment (effort >= high), action items table (P0 critical / P1 high / P2 medium), statistics table (per-chunk: files, lines, issues, C/H/M/L, time).

### 8. Session Finalization

Create master session for synthesized report:
```bash
INIT_OUTPUT=$(node "$RUNNER" init --skill-name codex-codebase-review --working-dir "$PWD")
MASTER_SESSION_DIR=${INIT_OUTPUT#CODEX_SESSION:}
ALL_SESSION_DIRS+=("$MASTER_SESSION_DIR")
```

Finalize with aggregated stats:
```bash
node "$RUNNER" finalize "$MASTER_SESSION_DIR" <<FINALIZE_EOF
{"verdict":"...","scope":"codebase","issues":{"total_found":$TOTAL_FOUND,"total_fixed":$TOTAL_FIXED,"total_disputed":$TOTAL_DISPUTED}}
FINALIZE_EOF
```
Report `$MASTER_SESSION_DIR` path to user.

### 9. Cleanup + Errors

```bash
for SESSION_DIR in "${ALL_SESSION_DIRS[@]}"; do
  node "$RUNNER" stop "$SESSION_DIR"
done
```
**Always run cleanup** — stop ALL tracked sessions (chunk + validation + master) regardless of outcome.

**Chunk failure**: Poll `failed` → retry once; still fails → skip, note "SKIPPED: {reason}" (use partial `review.raw_markdown` if available). **>50% chunks failed** → warn user, ask continue or abort. **All chunks failed** → Claude fallback review of top 5 priority chunks, report as "Fallback: Claude-only review". **Validation failure** → skip, use cross-cutting findings as-is. **Poll `timeout`** → report partial results, suggest lower effort. **Poll `stalled`** → if `recoverable === true`: `stop` → prepend recovery note → `resume --recovery` → poll (30s, 15s+). If `recoverable === false`: report partial results, suggest lower effort. **Start `error` with `CODEX_NOT_FOUND`** → tell user to install codex. **Stop `error`** → log warning, continue stopping remaining sessions. **Cleanup sequencing**: run `finalize` + `stop` ONLY after recovery resolves (success or second failure). Do NOT finalize before recovery attempt. Exit codes: 0=success, 2=timeout, 3=retry once, 4=stalled partial, 5=codex not found.

## Rules
- If invoked during Claude Code plan mode, exit plan mode first — this skill requires code editing.
- Codex reviews only; it does not edit files.
- No cross-contamination between chunk sessions — each chunk is independent.
- Context propagation: only high/critical findings from prior chunks, capped at ~2000 tokens.
- Cleanup always runs — stop every tracked SESSION_DIR regardless of outcome.
- Scope is full codebase only — for diff review use `/codex-impl-review`.
- **Runner manages all session state** — do NOT manually read/write `rounds.json`, `meta.json`, or `prompt.txt` in the session directory.
- **All runner commands return JSON** (except `version`, `init`, `render`) — always parse structured output, never scrape stderr.
