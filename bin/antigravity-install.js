#!/usr/bin/env node

/**
 * Antigravity Installer
 *
 * Installs codex-review skills into Google Antigravity IDE.
 * Mirrors the logic of bin/codex-skill.js but targets Antigravity paths.
 *
 * Usage:
 *   node bin/antigravity-install.js [-full] [--format commands|skills]
 *
 * Target directories:
 *   commands format: ~/.agent/commands/<skill-name>.md   (explicit /slash invocation)
 *   skills format:   ~/.gemini/antigravity/skills/<name>/ (auto-triggered)
 *
 * The shared runner is always installed to:
 *   ~/.gemini/antigravity/codex-review/scripts/codex-runner.js
 */

// Runtime guard: Node.js >= 22 required
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  console.error(`Error: Node.js >= 22 required (found ${process.version})`);
  process.exit(1);
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertToCommand,
  convertToSkill,
} from '../tools/antigravity-converter.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

const skillPackDir = path.join(packageRoot, 'skill-packs', 'codex-review');

const CORE_SKILLS = [
  'codex-plan-review',
  'codex-impl-review',
  'codex-think-about',
  'codex-commit-review',
  'codex-pr-review',
];
const FULL_SKILLS = [
  'codex-parallel-review',
  'codex-codebase-review',
  'codex-security-review',
];

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const fullMode = process.argv.includes('-full');
const SKILLS = fullMode ? [...CORE_SKILLS, ...FULL_SKILLS] : CORE_SKILLS;

let format = 'commands';
const fmtIdx = process.argv.indexOf('--format');
if (fmtIdx !== -1 && process.argv[fmtIdx + 1]) {
  format = process.argv[fmtIdx + 1];
}
if (!['commands', 'skills'].includes(format)) {
  console.error(`Error: invalid format "${format}". Must be "commands" or "skills".`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Target paths based on format
// ---------------------------------------------------------------------------

function getTargetPaths(format) {
  const home = os.homedir();
  if (format === 'commands') {
    return {
      skillsRoot: path.join(home, '.agent', 'commands'),
      runnerBase: path.join(home, '.gemini', 'antigravity', 'codex-review'),
    };
  }
  // skills format
  return {
    skillsRoot: path.join(home, '.gemini', 'antigravity', 'skills'),
    runnerBase: path.join(home, '.gemini', 'antigravity', 'codex-review'),
  };
}

const { skillsRoot, runnerBase } = getTargetPaths(format);
const runnerDir = path.join(runnerBase, 'scripts');
const runnerPath = path.join(runnerDir, 'codex-runner.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape characters special in double-quoted shell strings */
function escapeForDoubleQuotedShell(s) {
  return s.replace(/[\\"$`]/g, '\\$&');
}

/** Recursively copy a directory */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Build staging directory
// ---------------------------------------------------------------------------

const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stagingDir = path.join(path.dirname(skillsRoot), `.codex-ag-staging-${uid}`);

try {
  fs.mkdirSync(stagingDir, { recursive: true });

  // 1. Copy codex-runner.js into staging runner location
  const runnerSrc = path.join(skillPackDir, 'scripts', 'codex-runner.js');
  const runnerStagingDir = path.join(stagingDir, '_runner', 'scripts');
  fs.mkdirSync(runnerStagingDir, { recursive: true });
  fs.copyFileSync(runnerSrc, path.join(runnerStagingDir, 'codex-runner.js'));

  // ESM package.json
  fs.writeFileSync(
    path.join(stagingDir, '_runner', 'package.json'),
    '{"type":"module"}\n',
    'utf8'
  );

  // chmod +x on Unix
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(runnerStagingDir, 'codex-runner.js'), 0o755);
  }

  // 2. Convert and write each skill
  const escapedRunnerPath = escapeForDoubleQuotedShell(runnerPath);
  const escapedSkillsRoot = escapeForDoubleQuotedShell(skillsRoot);
  const convertFn = format === 'skills' ? convertToSkill : convertToCommand;

  for (const skill of SKILLS) {
    const skillSrcDir = path.join(skillPackDir, 'skills', skill);
    const templatePath = path.join(skillSrcDir, 'SKILL.md');

    // Read original template (normalize CRLF → LF for cross-platform)
    const template = fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');

    // Convert to Antigravity format
    let converted;
    try {
      converted = convertFn(template);
    } catch (err) {
      throw new Error(`Failed to convert ${skill}: ${err.message}`);
    }

    // Inject actual runner path (replace AG placeholders)
    let injected = converted.content;
    injected = injected.replaceAll('{{AG_RUNNER_PATH}}', escapedRunnerPath);
    injected = injected.replaceAll('{{AG_SKILLS_DIR}}', escapedSkillsRoot);

    // Write to staging
    const skillDestDir = path.join(stagingDir, skill);
    fs.mkdirSync(skillDestDir, { recursive: true });
    fs.writeFileSync(path.join(skillDestDir, 'SKILL.md'), injected, 'utf8');

    // Copy references/
    const refsSrc = path.join(skillSrcDir, 'references');
    if (fs.existsSync(refsSrc)) {
      copyDirSync(refsSrc, path.join(skillDestDir, 'references'));
    }

    // Copy shared files into references/
    const sharedDir = path.join(skillPackDir, 'shared');
    if (fs.existsSync(sharedDir)) {
      const skillRefsDir = path.join(skillDestDir, 'references');
      fs.mkdirSync(skillRefsDir, { recursive: true });
      for (const entry of fs.readdirSync(sharedDir)) {
        const sharedFile = path.join(sharedDir, entry);
        if (fs.statSync(sharedFile).isFile()) {
          fs.copyFileSync(sharedFile, path.join(skillRefsDir, entry));
        }
      }
    }
  }

  // 3. Verify runner works
  console.log('Verifying codex-runner.js ...');
  const runnerTestPath = path.join(stagingDir, '_runner', 'scripts', 'codex-runner.js');
  const versionOutput = execFileSync(process.execPath, [runnerTestPath, 'version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  console.log(`  codex-runner.js version: ${versionOutput}`);

  // Check Codex CLI availability (warning only)
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(whichCmd, ['codex'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    console.warn('');
    console.warn('\u26a0\ufe0f  Warning: codex CLI not found in PATH.');
    console.warn('   Skills require the Codex CLI to run.');
    console.warn('   Install: npm install -g @openai/codex');
  }

  // 4. Atomic swap
  // Install runner
  fs.mkdirSync(path.dirname(runnerBase), { recursive: true });
  const runnerBackup = `${runnerBase}-backup-${uid}`;
  if (fs.existsSync(runnerBase)) {
    fs.renameSync(runnerBase, runnerBackup);
  }
  fs.mkdirSync(runnerBase, { recursive: true });
  copyDirSync(path.join(stagingDir, '_runner'), runnerBase);

  // Install skills
  fs.mkdirSync(skillsRoot, { recursive: true });
  const backups = [];
  const swapped = [];

  try {
    for (const skill of SKILLS) {
      const target = path.join(skillsRoot, skill);
      const staged = path.join(stagingDir, skill);
      if (fs.existsSync(target)) {
        const backup = path.join(skillsRoot, `.${skill}-backup-${uid}`);
        fs.renameSync(target, backup);
        backups.push({ dir: skill, target, backup });
      }
      fs.renameSync(staged, target);
      swapped.push({ dir: skill, target });
    }
  } catch (err) {
    // Rollback
    const rollbackErrors = [];
    for (const { dir, target } of swapped) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) {
        rollbackErrors.push(`rm ${dir}: ${e.message}`);
      }
    }
    for (const { dir, target, backup } of backups) {
      try { fs.renameSync(backup, target); } catch (e) {
        rollbackErrors.push(`restore ${dir}: ${e.message}`);
      }
    }
    // Restore runner
    if (fs.existsSync(runnerBackup)) {
      try {
        fs.rmSync(runnerBase, { recursive: true, force: true });
        fs.renameSync(runnerBackup, runnerBase);
      } catch { /* best effort */ }
    }
    if (rollbackErrors.length) {
      console.error('Rollback errors:');
      for (const re of rollbackErrors) console.error(`  - ${re}`);
    }
    throw new Error(`Installation failed: ${err.message}`);
  }

  // Cleanup backups + staging
  for (const { backup } of backups) {
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch { }
  }
  if (fs.existsSync(runnerBackup)) {
    try { fs.rmSync(runnerBackup, { recursive: true, force: true }); } catch { }
  }
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }

  // In default mode, remove previously-installed full-only skills
  if (!fullMode) {
    for (const skill of FULL_SKILLS) {
      const target = path.join(skillsRoot, skill);
      if (fs.existsSync(target)) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch { }
      }
    }
  }

  // 5. Success message
  console.log('');
  console.log(`codex-review skills installed for Antigravity IDE!${fullMode ? ' (full mode)' : ''}`);
  console.log(`  Format: ${format}`);
  console.log(`  Runner: ${runnerBase}`);
  console.log(`  Skills: ${skillsRoot}`);
  console.log('');
  console.log(`Installed skills (${format} format):`);
  for (const skill of SKILLS) {
    const label = skill.replace('codex-', '');
    console.log(`  /${skill} — ${label}`);
  }
  if (!fullMode) {
    console.log('');
    console.log('Additional skills available with -full flag:');
    for (const skill of FULL_SKILLS) {
      console.log(`  /${skill}`);
    }
  }

} catch (err) {
  // Cleanup staging on failure
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }
  console.error(`\nError: ${err.message}`);
  process.exit(1);
}
