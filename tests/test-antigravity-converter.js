#!/usr/bin/env node

/**
 * Tests for tools/antigravity-converter.js
 *
 * Run: node tests/test-antigravity-converter.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseClaudeFrontmatter,
  convertToCommand,
  convertToSkill,
  inferTriggers,
  adaptReferences,
  convertAll,
} from '../tools/antigravity-converter.js';

// ============================================================
// Fixtures
// ============================================================

const VALID_SKILL_MD = `---
name: codex-plan-review
description: Review/debate plans before implementation between Claude Code and Codex CLI.
---

# Codex Plan Review

## Purpose
Adversarially review a plan before implementation starts.

## Runner
RUNNER="{{RUNNER_PATH}}"
SKILLS_DIR="{{SKILLS_DIR}}"

## Workflow
### 1. Collect Inputs
Plan-path detection.
`;

const MINIMAL_SKILL_MD = `---
name: test-skill
description: A test skill.
---

Body content here.
`;

const NO_FRONTMATTER = `# Just a heading

No YAML frontmatter.
`;

const MISSING_NAME = `---
description: Has description but no name.
---

Body.
`;

const MISSING_DESCRIPTION = `---
name: has-name
---

Body.
`;

// ============================================================
// parseClaudeFrontmatter
// ============================================================

describe('parseClaudeFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const result = parseClaudeFrontmatter(VALID_SKILL_MD);
    assert.equal(result.name, 'codex-plan-review');
    assert.match(result.description, /Review\/debate plans/);
    assert.match(result.body, /# Codex Plan Review/);
    assert.ok(!result.body.startsWith('---'));
  });

  it('parses minimal frontmatter', () => {
    const result = parseClaudeFrontmatter(MINIMAL_SKILL_MD);
    assert.equal(result.name, 'test-skill');
    assert.equal(result.description, 'A test skill.');
    assert.match(result.body, /Body content here/);
  });

  it('throws on missing frontmatter', () => {
    assert.throws(() => parseClaudeFrontmatter(NO_FRONTMATTER), /No YAML frontmatter/);
  });

  it('throws on missing name', () => {
    assert.throws(() => parseClaudeFrontmatter(MISSING_NAME), /missing required "name"/);
  });

  it('throws on missing description', () => {
    assert.throws(() => parseClaudeFrontmatter(MISSING_DESCRIPTION), /missing required "description"/);
  });

  it('body does not include frontmatter delimiters', () => {
    const result = parseClaudeFrontmatter(VALID_SKILL_MD);
    assert.ok(!result.body.includes('---\nname:'));
  });
});

// ============================================================
// convertToCommand
// ============================================================

describe('convertToCommand', () => {
  it('produces Antigravity command format', () => {
    const result = convertToCommand(VALID_SKILL_MD);
    assert.equal(result.name, 'codex-plan-review');
    assert.equal(result.filename, 'codex-plan-review.md');
    // Has Antigravity frontmatter
    assert.match(result.content, /^---\n/);
    assert.match(result.content, /description: Review\/debate plans/);
    // No triggers in command format
    assert.ok(!result.content.includes('triggers:'));
  });

  it('remaps RUNNER_PATH placeholder', () => {
    const result = convertToCommand(VALID_SKILL_MD);
    assert.ok(!result.content.includes('{{RUNNER_PATH}}'));
    assert.ok(result.content.includes('{{AG_RUNNER_PATH}}'));
  });

  it('remaps SKILLS_DIR placeholder', () => {
    const result = convertToCommand(VALID_SKILL_MD);
    assert.ok(!result.content.includes('{{SKILLS_DIR}}'));
    assert.ok(result.content.includes('{{AG_SKILLS_DIR}}'));
  });

  it('replaces Claude Code references in body', () => {
    const input = `---
name: test
description: Test skill.
---

This uses Claude Code for review.
Config at ~/.claude/skills/test/.
`;
    const result = convertToCommand(input);
    // Body references should be replaced
    const bodyStart = result.content.indexOf('---', 4) + 4; // after closing ---
    const body = result.content.slice(bodyStart);
    assert.ok(!body.includes('Claude Code'), 'Body should not have Claude Code');
    assert.ok(body.includes('Antigravity'), 'Body should have Antigravity');
    assert.ok(!body.includes('~/.claude/skills/'), 'Body should not have ~/.claude/skills/');
    assert.ok(body.includes('~/.gemini/antigravity/skills/'), 'Body should have Antigravity path');
  });
});

// ============================================================
// convertToSkill
// ============================================================

describe('convertToSkill', () => {
  it('produces Antigravity skill format with triggers', () => {
    const result = convertToSkill(VALID_SKILL_MD);
    assert.equal(result.name, 'codex-plan-review');
    assert.match(result.content, /triggers:/);
    assert.match(result.content, /plan file created or modified/);
  });

  it('has correct frontmatter structure', () => {
    const result = convertToSkill(VALID_SKILL_MD);
    const lines = result.content.split('\n');
    assert.equal(lines[0], '---');
    // Find closing ---
    const closeIdx = lines.indexOf('---', 1);
    assert.ok(closeIdx > 0, 'Should have closing --- in frontmatter');
  });

  it('remaps placeholders like convertToCommand', () => {
    const result = convertToSkill(VALID_SKILL_MD);
    assert.ok(!result.content.includes('{{RUNNER_PATH}}'));
    assert.ok(result.content.includes('{{AG_RUNNER_PATH}}'));
  });
});

// ============================================================
// inferTriggers
// ============================================================

describe('inferTriggers', () => {
  it('infers plan-review triggers', () => {
    const t = inferTriggers('codex-plan-review', 'review plans');
    assert.ok(t.some(x => x.includes('plan')));
  });

  it('infers impl-review triggers', () => {
    const t = inferTriggers('codex-impl-review', 'review changes');
    assert.ok(t.some(x => x.includes('uncommitted')));
  });

  it('infers commit-review triggers', () => {
    const t = inferTriggers('codex-commit-review', 'review commits');
    assert.ok(t.some(x => x.includes('commit')));
  });

  it('infers pr-review triggers', () => {
    const t = inferTriggers('codex-pr-review', 'review PRs');
    assert.ok(t.some(x => x.includes('pull request')));
  });

  it('infers think-about triggers', () => {
    const t = inferTriggers('codex-think-about', 'peer debate');
    assert.ok(t.some(x => x.includes('technical')));
  });

  it('infers security-review triggers', () => {
    const t = inferTriggers('codex-security-review', 'security review');
    assert.ok(t.some(x => x.includes('security')));
  });

  it('infers codebase-review triggers', () => {
    const t = inferTriggers('codex-codebase-review', 'full codebase');
    assert.ok(t.some(x => x.includes('codebase')));
  });

  it('infers parallel-review triggers', () => {
    const t = inferTriggers('codex-parallel-review', 'parallel');
    assert.ok(t.some(x => x.includes('parallel')));
  });

  it('returns empty for unknown skill', () => {
    const t = inferTriggers('codex-unknown-thing', 'something');
    assert.equal(t.length, 0);
  });
});

// ============================================================
// adaptReferences
// ============================================================

describe('adaptReferences', () => {
  it('replaces "Claude Code" with "Antigravity"', () => {
    assert.equal(adaptReferences('Uses Claude Code for X'), 'Uses Antigravity for X');
  });

  it('replaces ~/.claude/skills/ paths', () => {
    const result = adaptReferences('Installed at ~/.claude/skills/foo');
    assert.equal(result, 'Installed at ~/.gemini/antigravity/skills/foo');
  });

  it('replaces ~/.claude/CLAUDE.md', () => {
    const result = adaptReferences('Config at ~/.claude/CLAUDE.md');
    assert.equal(result, 'Config at ~/.gemini/settings.json');
  });

  it('does not modify unrelated text', () => {
    const input = 'Just some normal text with no references.';
    assert.equal(adaptReferences(input), input);
  });

  it('handles multiple replacements in one string', () => {
    const input = 'Claude Code uses ~/.claude/skills/ and Claude Code is great';
    const result = adaptReferences(input);
    assert.equal(result, 'Antigravity uses ~/.gemini/antigravity/skills/ and Antigravity is great');
  });
});

// ============================================================
// convertAll (integration test with temp directory)
// ============================================================

describe('convertAll', () => {
  it('converts all skills from a directory', () => {
    // Create temp input structure
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');

    try {
      // Create two fake skills
      for (const name of ['skill-a', 'skill-b']) {
        const skillDir = path.join(inputDir, name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: ${name}
description: Test ${name}.
---

# ${name}

RUNNER="{{RUNNER_PATH}}"
SKILLS_DIR="{{SKILLS_DIR}}"
`, 'utf8');

        // Add a references/ dir
        const refsDir = path.join(skillDir, 'references');
        fs.mkdirSync(refsDir, { recursive: true });
        fs.writeFileSync(path.join(refsDir, 'prompts.md'), '# Prompts', 'utf8');
      }

      // Convert as commands
      const results = convertAll(inputDir, outputDir, 'commands');

      assert.equal(results.length, 2);
      assert.ok(results.some(r => r.name === 'skill-a'));
      assert.ok(results.some(r => r.name === 'skill-b'));

      // Verify output files exist
      for (const name of ['skill-a', 'skill-b']) {
        const skillMd = path.join(outputDir, name, 'SKILL.md');
        assert.ok(fs.existsSync(skillMd), `${skillMd} should exist`);

        const content = fs.readFileSync(skillMd, 'utf8');
        assert.match(content, /description:/);
        assert.ok(content.includes('{{AG_RUNNER_PATH}}'));

        // References copied
        const refsPath = path.join(outputDir, name, 'references', 'prompts.md');
        assert.ok(fs.existsSync(refsPath), `${refsPath} should exist`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('converts with skills format including triggers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');

    try {
      const skillDir = path.join(inputDir, 'codex-impl-review');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: codex-impl-review
description: Review uncommitted changes.
---

Body here.
`, 'utf8');
      fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'references', 'test.md'), 'ref', 'utf8');

      const results = convertAll(inputDir, outputDir, 'skills');

      assert.equal(results.length, 1);
      const content = fs.readFileSync(results[0].outputPath, 'utf8');
      assert.match(content, /triggers:/);
      assert.match(content, /uncommitted/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips directories without SKILL.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');

    try {
      // Dir with SKILL.md
      const withSkill = path.join(inputDir, 'has-skill');
      fs.mkdirSync(withSkill, { recursive: true });
      fs.writeFileSync(path.join(withSkill, 'SKILL.md'), MINIMAL_SKILL_MD, 'utf8');

      // Dir without SKILL.md
      const withoutSkill = path.join(inputDir, 'no-skill');
      fs.mkdirSync(withoutSkill, { recursive: true });
      fs.writeFileSync(path.join(withoutSkill, 'readme.txt'), 'not a skill', 'utf8');

      const results = convertAll(inputDir, outputDir, 'commands');
      assert.equal(results.length, 1);
      assert.equal(results[0].name, 'test-skill');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Conversion of real SKILL.md files (integration)
// ============================================================

describe('real SKILL.md conversion', () => {
  const skillsDir = path.resolve(
    new URL(import.meta.url).pathname,
    '../../skill-packs/codex-review/skills'
  );

  // Only run if the skills directory exists (repo context)
  const hasSkills = fs.existsSync(skillsDir);

  it('converts all real skills without errors', { skip: !hasSkills }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-real-'));
    try {
      const results = convertAll(skillsDir, tmpDir, 'commands');
      assert.ok(results.length >= 5, `Expected at least 5 skills, got ${results.length}`);

      for (const r of results) {
        const content = fs.readFileSync(r.outputPath, 'utf8');
        // Should have Antigravity frontmatter
        assert.match(content, /^---\n/, `${r.name} should start with ---`);
        // Should not have Claude Code RUNNER_PATH placeholder
        assert.ok(!content.includes('{{RUNNER_PATH}}'), `${r.name} should not have {{RUNNER_PATH}}`);
        // Should have AG placeholder
        assert.ok(
          content.includes('{{AG_RUNNER_PATH}}'),
          `${r.name} should have {{AG_RUNNER_PATH}}`
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('converts all real skills to skill format', { skip: !hasSkills }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-real-'));
    try {
      const results = convertAll(skillsDir, tmpDir, 'skills');
      assert.ok(results.length >= 5);

      for (const r of results) {
        const content = fs.readFileSync(r.outputPath, 'utf8');
        assert.match(content, /triggers:/, `${r.name} should have triggers`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
