# Prompt Templates

## Round 1 Prompt
```
## Your Role
You are an equal peer thinker with Claude Code.

## Question
{QUESTION}

## Project Context
{PROJECT_CONTEXT}

## Relevant Files
{RELEVANT_FILES}

## Known Constraints
{CONSTRAINTS}

## Instructions
1. Think independently.
2. Separate facts, assumptions, and recommendations.
3. Use required output format exactly.

## Required Output Format
{OUTPUT_FORMAT}
```

## Round 2+ Response Prompt
```
## Points I Agree With
{AGREED_POINTS}

## Points I Disagree With
{DISAGREED_POINTS}

## Additional Perspectives
{NEW_PERSPECTIVES}

## Current Status
{CONTINUE_OR_CONSENSUS_OR_STALEMATE}

## Your Turn
Respond in required output format and address disagreements directly.
```
