#!/usr/bin/env node

// Runtime guard: Node.js >= 22 required (Codex CLI requirement)
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
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// CLI Arguments
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    auto: { type: 'boolean', default: false },
  },
  strict: false,
});

const AUTO_MODE = args.auto;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

const skillPackDir = path.join(packageRoot, 'skill-packs', 'codex-review');
const skillsRoot = path.join(os.homedir(), '.claude', 'skills');
const runnerDir = path.join(skillsRoot, 'codex-review');
const runnerPath = path.join(runnerDir, 'scripts', 'codex-runner.js');

const SKILLS = ['codex-plan-review', 'codex-impl-review', 'codex-think-about', 'codex-commit-review', 'codex-pr-review', 'codex-parallel-review', 'codex-codebase-review', 'codex-security-review'];

// All directories managed by this installer (runner + 8 skills)
const MANAGED_DIRS = ['codex-review', ...SKILLS];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape characters special in double-quoted shell strings: \ " $ ` */
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

/**
 * Resolve project root directory (git repo root or cwd fallback)
 * @returns {string} Absolute path to project root
 */
function resolveProjectRoot() {
  try {
    // Try to find git repository root
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
    }).trim();
    
    if (gitRoot && fs.existsSync(gitRoot)) {
      return gitRoot;
    }
  } catch (err) {
    // Git not available or not in a git repo - fall back to cwd
  }
  
  return process.cwd();
}

/**
 * Generate auto-review guidance content for CLAUDE.md
 * @returns {string} Markdown content with auto-review triggers
 */
function generateAutoReviewGuidance() {
  return `
<!-- BEGIN CODEX-AUTO-REVIEW -->
## Codex Auto-Review Integration

**IMPORTANT**: This project has codex-review skills installed with auto-review mode enabled.

### When to Automatically Invoke Review Skills

The following rules guide when to automatically trigger code review skills WITHOUT explicit user request:

#### 1. Before Creating Commits (\`/codex-impl-review\`)
**Trigger**: When user asks to commit changes OR you detect uncommitted changes before a commit operation.
**Action**: Automatically run \`/codex-impl-review\` to review working tree changes.
**Example phrases**: "commit these changes", "create a commit", "git commit"

#### 2. Before Creating Pull Requests (\`/codex-pr-review\`)
**Trigger**: When user asks to create a PR OR you're about to run \`gh pr create\`.
**Action**: Automatically run \`/codex-pr-review\` to review branch diff, commit history, and PR description.
**Example phrases**: "create a PR", "open a pull request", "submit for review"

#### 3. When Plan Files Are Detected (\`/codex-plan-review\`)
**Trigger**: When you create or significantly modify files matching: \`plan.md\`, \`PLAN.md\`, \`*.plan.md\`, or \`docs/*plan*\`.
**Action**: Automatically run \`/codex-plan-review\` to validate the implementation plan.
**Example phrases**: "write an implementation plan", "create a plan document"

#### 4. When Security-Sensitive Code Is Detected (\`/codex-security-review\`)
**Trigger**: When changes involve:
- Authentication/authorization logic
- SQL queries or database operations
- Cryptography or password handling
- User input processing
- File uploads or external API calls
**Action**: Automatically run \`/codex-security-review\` for security-focused analysis.

#### 5. Comprehensive Auto-Review (\`/codex-auto-review\`)
**Trigger**: When user explicitly requests comprehensive review OR before major milestones (feature completion, release prep).
**Action**: Run \`/codex-auto-review\` which auto-detects relevant skills and runs them in parallel.
**Example phrases**: "review everything", "comprehensive code review", "full review before merge"

### Execution Guidelines

- **Always announce**: Before auto-triggering a review, briefly state: "Running \`/codex-<skill>\` (auto-review mode)..."
- **Show results**: Present review findings to the user and ask for confirmation before applying fixes.
- **User override**: If user says "skip review" or "no review needed", respect their decision.
- **Failure handling**: If a review skill fails or times out, report the error and ask user whether to proceed without review.

### Manual Invocation Still Available

Users can still manually invoke any skill:
- \`/codex-plan-review\` — debate plans before implementation
- \`/codex-impl-review\` — review uncommitted or branch changes
- \`/codex-commit-review\` — review commit messages
- \`/codex-pr-review\` — review PRs (branch diff + description)
- \`/codex-security-review\` — security-focused review (OWASP Top 10 + CWE)
- \`/codex-parallel-review\` — parallel dual-reviewer analysis + debate
- \`/codex-codebase-review\` — chunked full-codebase review (50-500+ files)
- \`/codex-auto-review\` — smart auto-detection + parallel review
- \`/codex-think-about\` — peer reasoning/debate on technical topics
<!-- END CODEX-AUTO-REVIEW -->
`;
}

/**
 * Inject or update auto-review guidance in CLAUDE.md
 * @param {string} targetDir - Directory containing CLAUDE.md (default: project root)
 * @throws {Error} If injection fails
 */
function injectAutoReviewGuidance(targetDir = null) {
  // Resolve target directory (project root by default)
  if (!targetDir) {
    targetDir = resolveProjectRoot();
  }
  
  const claudeMdPath = path.join(targetDir, 'CLAUDE.md');
  const beginMarker = '<!-- BEGIN CODEX-AUTO-REVIEW -->';
  const endMarker = '<!-- END CODEX-AUTO-REVIEW -->';
  const guidance = generateAutoReviewGuidance();

  let content = '';
  let fileExists = false;

  // Read existing CLAUDE.md if it exists
  if (fs.existsSync(claudeMdPath)) {
    content = fs.readFileSync(claudeMdPath, 'utf8');
    fileExists = true;
  }

  // Check if guidance already exists (idempotent)
  const beginIndex = content.indexOf(beginMarker);
  const endIndex = content.indexOf(endMarker);
  
  if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    // Remove old guidance section (from BEGIN to END marker inclusive)
    content = content.slice(0, beginIndex) + content.slice(endIndex + endMarker.length);
  } else if (beginIndex !== -1 || endIndex !== -1) {
    // Malformed markers - one exists but not the other
    throw new Error('Malformed CODEX-AUTO-REVIEW markers in CLAUDE.md. Please remove them manually and re-run.');
  }

  // Append new guidance
  content = content.trimEnd() + '\n' + guidance + '\n';

  // Write back to CLAUDE.md
  fs.writeFileSync(claudeMdPath, content, 'utf8');

  return { path: claudeMdPath, existed: fileExists, projectRoot: targetDir };
}

// ---------------------------------------------------------------------------
// Build staging directory
// ---------------------------------------------------------------------------

const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stagingDir = path.join(skillsRoot, `.codex-staging-${uid}`);

try {
  fs.mkdirSync(stagingDir, { recursive: true });

  // 1. Copy codex-runner.js into staging/codex-review/scripts/
  const runnerSrc = path.join(skillPackDir, 'scripts', 'codex-runner.js');
  const runnerDest = path.join(stagingDir, 'codex-review', 'scripts', 'codex-runner.js');
  fs.mkdirSync(path.dirname(runnerDest), { recursive: true });
  fs.copyFileSync(runnerSrc, runnerDest);

  // chmod +x on Unix
  if (process.platform !== 'win32') {
    fs.chmodSync(runnerDest, 0o755);
  }

  // 2. Process each skill: inject RUNNER_PATH into SKILL.md, copy references/
  const escapedRunnerPath = escapeForDoubleQuotedShell(runnerPath);

  for (const skill of SKILLS) {
    const skillSrcDir = path.join(skillPackDir, 'skills', skill);
    const skillDestDir = path.join(stagingDir, skill);
    fs.mkdirSync(skillDestDir, { recursive: true });

    // Read template SKILL.md, inject runner path
    const templatePath = path.join(skillSrcDir, 'SKILL.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    if (!template.includes('{{RUNNER_PATH}}')) {
      throw new Error(`Template ${skill}/SKILL.md missing {{RUNNER_PATH}} placeholder`);
    }
    const injected = template.replaceAll('{{RUNNER_PATH}}', escapedRunnerPath);
    if (injected.includes('{{RUNNER_PATH}}')) {
      throw new Error(`Template ${skill}/SKILL.md still contains {{RUNNER_PATH}} after injection`);
    }
    fs.writeFileSync(path.join(skillDestDir, 'SKILL.md'), injected, 'utf8');

    // Copy references/ directory (required by all skills)
    const refsSrc = path.join(skillSrcDir, 'references');
    if (!fs.existsSync(refsSrc)) {
      throw new Error(`Missing references/ directory for ${skill}`);
    }
    copyDirSync(refsSrc, path.join(skillDestDir, 'references'));
  }

  // 3. Verify runner works
  console.log('Verifying codex-runner.js ...');
  const runnerTestPath = path.join(stagingDir, 'codex-review', 'scripts', 'codex-runner.js');
  const versionOutput = execFileSync(process.execPath, [runnerTestPath, 'version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  console.log(`  codex-runner.js version: ${versionOutput}`);

  // 4. Atomic swap per directory: backup old → move staging → cleanup
  fs.mkdirSync(skillsRoot, { recursive: true });
  const backups = [];    // dirs that had a previous install → backed up
  const swapped = [];    // dirs successfully moved from staging → target
  try {
    for (const dir of MANAGED_DIRS) {
      const target = path.join(skillsRoot, dir);
      const staged = path.join(stagingDir, dir);
      if (fs.existsSync(target)) {
        const backup = path.join(skillsRoot, `.${dir}-backup-${uid}`);
        fs.renameSync(target, backup);
        backups.push({ dir, target, backup });
      }
      fs.renameSync(staged, target);
      swapped.push({ dir, target });
    }
  } catch (err) {
    // Swap failed → full rollback: remove new targets, restore backups
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
    if (rollbackErrors.length) {
      console.error('Rollback errors (manual cleanup may be needed):');
      for (const re of rollbackErrors) console.error(`  - ${re}`);
    }
    throw new Error(`Installation failed: ${err.message}`);
  }

  // Cleanup backups and empty staging dir (non-critical — install already succeeded)
  for (const { backup } of backups) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      console.warn(`Warning: could not remove backup at ${backup}`);
    }
  }
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // staging dir may already be gone
  }

  // 5. Auto-review mode: inject guidance into CLAUDE.md
  if (AUTO_MODE) {
    console.log('');
    console.log('Configuring auto-review mode...');
    
    try {
      const result = injectAutoReviewGuidance();
      console.log('Auto-review mode enabled!');
      console.log(`  ${result.existed ? 'Updated' : 'Created'}: ${result.path}`);
      console.log(`  Project root: ${result.projectRoot}`);
      console.log('  Claude Code will now automatically trigger reviews at appropriate times.');
    } catch (err) {
      // Auto-review injection failed - this is a critical error for --auto mode
      console.error('');
      console.error('ERROR: Failed to enable auto-review mode');
      console.error(`  ${err.message}`);
      console.error('');
      console.error('Skills were installed successfully, but auto-review configuration failed.');
      console.error('You can:');
      console.error('  - Fix the issue and re-run: npx github:lploc94/codex_skill --auto');
      console.error('  - Use manual invocation: npx github:lploc94/codex_skill (without --auto)');
      process.exit(1);
    }
  }

  // 6. Success message
  console.log('');
  console.log('codex-review skills installed successfully!');
  console.log(`  Runner:  ${runnerDir}`);
  console.log(`  Skills:  ${skillsRoot}/codex-{plan-review,impl-review,think-about,commit-review,pr-review,parallel-review,codebase-review,security-review}`);
  console.log('');
  console.log('Skills available in Claude Code:');
  console.log('  /codex-plan-review     — debate plans before implementation');
  console.log('  /codex-impl-review     — review uncommitted or branch changes');
  console.log('  /codex-think-about     — peer reasoning/debate');
  console.log('  /codex-commit-review   — review commit messages');
  console.log('  /codex-pr-review       — review PRs (branch diff + description)');
  console.log('  /codex-parallel-review — parallel dual-reviewer analysis + debate');
  console.log('  /codex-codebase-review — chunked full-codebase review (50-500+ files)');
  console.log('  /codex-security-review — security-focused review (OWASP Top 10 + CWE)');
<<<<<<< HEAD
=======
  console.log('  /codex-auto-review     — smart auto-detection + parallel review');
  
  if (!AUTO_MODE) {
    console.log('');
    console.log('Tip: Run with --auto flag to enable automatic review triggers in CLAUDE.md');
  }
>>>>>>> df10663 (fix: improve --auto flag with proper error handling and project root detection)
} catch (err) {
  // Cleanup staging on any error
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  console.error(err.message || err);
  process.exit(1);
}
