# Prompt Templates

## Plan Review Prompt (Round 1)
```
## Your Role
You are Codex acting as a strict implementation-plan reviewer.

## Plan Location
{PLAN_PATH}

## User's Original Request
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Instructions
1. Read the plan file directly.
2. Identify gaps, risks, missing edge cases, and sequencing flaws.
3. Do not propose code changes; review only the plan quality.
4. Use the required output format exactly.

## Required Output Format
{OUTPUT_FORMAT}
```

## Rebuttal Prompt (Round 2+)
```
## Issues Accepted & Fixed
{FIXED_ITEMS}

## Issues Disputed
{DISPUTED_ITEMS}

## Your Turn
Re-review using the same output format. Keep prior accepted points closed unless regression exists.
```
