#!/usr/bin/env node

/**
 * Tests for bin/antigravity-install.js
 *
 * Tests the installer logic in isolation using a fake HOME directory.
 * Does NOT run the actual installer (which needs codex-runner.js to verify).
 * Instead, tests the helper functions and validates installer behavior
 * by running it against a temp HOME.
 *
 * Run: node tests/test-antigravity-install.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const installerPath = path.resolve(
  new URL(import.meta.url).pathname,
  '../../bin/antigravity-install.js'
);

const repoRoot = path.resolve(new URL(import.meta.url).pathname, '../..');

// ============================================================
// Helper: run installer with fake HOME
// ============================================================

function runInstaller(args = [], env = {}) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-install-test-'));
  try {
    const result = execFileSync(
      process.execPath,
      [installerPath, ...args],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: tmpHome,
          USERPROFILE: tmpHome, // Windows
          ...env,
        },
        cwd: repoRoot,
      }
    );
    return { output: result, home: tmpHome, error: null };
  } catch (err) {
    return { output: err.stdout || '', home: tmpHome, error: err };
  }
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { }
}

// ============================================================
// Installer integration tests
// ============================================================

describe('antigravity-install.js', () => {
  it('installs core skills in commands format (default)', () => {
    const { output, home, error } = runInstaller();
    try {
      if (error) {
        // Allow "codex CLI not found" warning but not hard failure
        if (error.status !== 0 && !output.includes('installed')) {
          assert.fail(`Installer failed: ${error.stderr || error.message}`);
        }
      }

      assert.match(output, /codex-runner\.js version:/);
      assert.match(output, /installed/i);

      // Runner installed
      const runnerDir = path.join(home, '.gemini', 'antigravity', 'codex-review', 'scripts');
      assert.ok(fs.existsSync(path.join(runnerDir, 'codex-runner.js')), 'runner should exist');

      // Core skills installed
      const skillsRoot = path.join(home, '.agent', 'commands');
      for (const skill of ['codex-plan-review', 'codex-impl-review', 'codex-think-about', 'codex-commit-review', 'codex-pr-review']) {
        const skillMd = path.join(skillsRoot, skill, 'SKILL.md');
        assert.ok(fs.existsSync(skillMd), `${skill}/SKILL.md should exist`);

        const content = fs.readFileSync(skillMd, 'utf8');
        // Should have Antigravity frontmatter (no "name:" field, just "description:")
        assert.match(content, /^---\n/, `${skill} should start with frontmatter`);
        assert.match(content, /description:/, `${skill} should have description`);
        // Placeholders should be injected with real paths
        assert.ok(!content.includes('{{AG_RUNNER_PATH}}'), `${skill} should not have AG placeholder`);
        assert.ok(!content.includes('{{RUNNER_PATH}}'), `${skill} should not have Claude placeholder`);
      }

      // Full-only skills should NOT be installed
      for (const skill of ['codex-parallel-review', 'codex-codebase-review', 'codex-security-review']) {
        const skillMd = path.join(skillsRoot, skill, 'SKILL.md');
        assert.ok(!fs.existsSync(skillMd), `${skill} should NOT be installed without -full`);
      }
    } finally {
      cleanup(home);
    }
  });

  it('installs all skills with -full flag', () => {
    const { output, home, error } = runInstaller(['-full']);
    try {
      if (error && error.status !== 0 && !output.includes('installed')) {
        assert.fail(`Installer failed: ${error.stderr || error.message}`);
      }

      const skillsRoot = path.join(home, '.agent', 'commands');
      const allSkills = [
        'codex-plan-review', 'codex-impl-review', 'codex-think-about',
        'codex-commit-review', 'codex-pr-review',
        'codex-parallel-review', 'codex-codebase-review', 'codex-security-review',
      ];
      for (const skill of allSkills) {
        const skillMd = path.join(skillsRoot, skill, 'SKILL.md');
        assert.ok(fs.existsSync(skillMd), `${skill}/SKILL.md should exist with -full`);
      }
    } finally {
      cleanup(home);
    }
  });

  it('installs in skills format with --format skills', () => {
    const { output, home, error } = runInstaller(['--format', 'skills']);
    try {
      if (error && error.status !== 0 && !output.includes('installed')) {
        assert.fail(`Installer failed: ${error.stderr || error.message}`);
      }

      // Skills should be in gemini/antigravity/skills/, not .agent/commands/
      const skillsRoot = path.join(home, '.gemini', 'antigravity', 'skills');
      const skillMd = path.join(skillsRoot, 'codex-plan-review', 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), 'plan-review should exist in skills dir');

      const content = fs.readFileSync(skillMd, 'utf8');
      assert.match(content, /triggers:/, 'Skills format should have triggers');
    } finally {
      cleanup(home);
    }
  });

  it('rejects invalid --format value', () => {
    const { error } = runInstaller(['--format', 'invalid']);
    try {
      assert.ok(error, 'Should fail with invalid format');
      assert.ok(
        (error.stderr || '').includes('invalid format') || (error.stdout || '').includes('invalid format'),
        'Should mention invalid format in error'
      );
    } finally {
      // No home to clean up on early exit
    }
  });

  it('copies references/ directories', () => {
    const { home, error, output } = runInstaller();
    try {
      if (error && error.status !== 0 && !output.includes('installed')) {
        assert.fail(`Installer failed: ${error.stderr || error.message}`);
      }

      const skillsRoot = path.join(home, '.agent', 'commands');
      const refsDir = path.join(skillsRoot, 'codex-plan-review', 'references');
      assert.ok(fs.existsSync(refsDir), 'references/ should exist');

      // Should have prompts.md and output-format.md
      const files = fs.readdirSync(refsDir);
      assert.ok(files.includes('prompts.md'), 'Should have prompts.md');
      assert.ok(files.includes('output-format.md'), 'Should have output-format.md');
      // Shared files should be copied too
      assert.ok(files.includes('protocol.md'), 'Should have shared protocol.md');
      assert.ok(files.includes('flavor-text.md'), 'Should have shared flavor-text.md');
    } finally {
      cleanup(home);
    }
  });

  it('creates ESM package.json for runner', () => {
    const { home, error, output } = runInstaller();
    try {
      if (error && error.status !== 0 && !output.includes('installed')) {
        assert.fail(`Installer failed: ${error.stderr || error.message}`);
      }

      const pkgJson = path.join(home, '.gemini', 'antigravity', 'codex-review', 'package.json');
      assert.ok(fs.existsSync(pkgJson), 'package.json should exist');
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      assert.equal(pkg.type, 'module');
    } finally {
      cleanup(home);
    }
  });

  it('is idempotent (second run succeeds)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-install-idem-'));
    try {
      // First install
      execFileSync(process.execPath, [installerPath], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
        cwd: repoRoot,
      });

      // Second install (should overwrite without error)
      const output = execFileSync(process.execPath, [installerPath], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
        cwd: repoRoot,
      });

      assert.match(output, /installed/i);
    } finally {
      cleanup(tmpHome);
    }
  });

  it('injected runner path points to correct location', () => {
    const { home, error, output } = runInstaller();
    try {
      if (error && error.status !== 0 && !output.includes('installed')) {
        assert.fail(`Installer failed: ${error.stderr || error.message}`);
      }

      const skillMd = path.join(home, '.agent', 'commands', 'codex-plan-review', 'SKILL.md');
      const content = fs.readFileSync(skillMd, 'utf8');

      // Extract the RUNNER= line
      const runnerMatch = content.match(/RUNNER="([^"]+)"/);
      assert.ok(runnerMatch, 'Should have RUNNER= line');

      const runnerPath = runnerMatch[1];
      assert.ok(runnerPath.includes('.gemini/antigravity/codex-review/scripts/codex-runner.js'),
        `Runner path should point to Antigravity location, got: ${runnerPath}`);

      // Verify the runner file actually exists at that path
      assert.ok(fs.existsSync(runnerPath), `Runner should exist at ${runnerPath}`);
    } finally {
      cleanup(home);
    }
  });
});
