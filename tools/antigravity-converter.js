#!/usr/bin/env node

/**
 * Antigravity Converter
 *
 * Converts Claude Code SKILL.md templates to Google Antigravity IDE format.
 *
 * Antigravity supports two target formats:
 *   1. Skills   — auto-triggered by AI based on context
 *                  Location: ~/.gemini/antigravity/skills/<name>/
 *   2. Commands — explicit /slash-command invocation
 *                  Location: ~/.agent/commands/<name>/
 *
 * Usage:
 *   node tools/antigravity-converter.js [--format skills|commands] [--input <dir>] [--output <dir>]
 *
 * Default: --format commands (preserves explicit /codex-* invocation)
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// Constants
// ============================================================

const CLAUDE_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

const RUNNER_PLACEHOLDER = '{{RUNNER_PATH}}';
const SKILLS_DIR_PLACEHOLDER = '{{SKILLS_DIR}}';
const AG_RUNNER_PLACEHOLDER = '{{AG_RUNNER_PATH}}';
const AG_SKILLS_DIR_PLACEHOLDER = '{{AG_SKILLS_DIR}}';

// ============================================================
// Parsers
// ============================================================

/**
 * Parse Claude Code YAML frontmatter from SKILL.md content.
 * Returns { name, description, body } where body is everything after the frontmatter.
 */
export function parseClaudeFrontmatter(content) {
  const match = content.match(CLAUDE_FRONTMATTER_RE);
  if (!match) {
    throw new Error('No YAML frontmatter found (expected --- delimiters)');
  }

  const yaml = match[1];
  const body = content.slice(match[0].length);

  const name = extractYamlField(yaml, 'name');
  const description = extractYamlField(yaml, 'description');

  if (!name) throw new Error('Frontmatter missing required "name" field');
  if (!description) throw new Error('Frontmatter missing required "description" field');

  return { name, description, body };
}

function extractYamlField(yaml, field) {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const m = yaml.match(re);
  return m ? m[1].trim() : null;
}

// ============================================================
// Converters
// ============================================================

/**
 * Convert Claude Code SKILL.md to Antigravity command format.
 *
 * Antigravity commands use YAML frontmatter with:
 *   - description (required)
 *   - Optional: model, temperature, tools
 *
 * Body is Markdown prompt instructions.
 */
export function convertToCommand(content) {
  const { name, description, body } = parseClaudeFrontmatter(content);

  // Remap placeholders
  let converted = body;
  converted = converted.replaceAll(RUNNER_PLACEHOLDER, AG_RUNNER_PLACEHOLDER);
  converted = converted.replaceAll(SKILLS_DIR_PLACEHOLDER, AG_SKILLS_DIR_PLACEHOLDER);

  // Rewrite Claude-specific references
  converted = adaptReferences(converted);

  const frontmatter = buildAntigravityFrontmatter({
    description,
    format: 'command',
  });

  return {
    name,
    filename: `${name}.md`,
    content: `${frontmatter}\n${converted}`,
  };
}

/**
 * Convert Claude Code SKILL.md to Antigravity skill format.
 *
 * Antigravity skills use YAML frontmatter with:
 *   - description (required)
 *   - triggers: list of context patterns for auto-detection
 */
export function convertToSkill(content) {
  const { name, description, body } = parseClaudeFrontmatter(content);

  let converted = body;
  converted = converted.replaceAll(RUNNER_PLACEHOLDER, AG_RUNNER_PLACEHOLDER);
  converted = converted.replaceAll(SKILLS_DIR_PLACEHOLDER, AG_SKILLS_DIR_PLACEHOLDER);
  converted = adaptReferences(converted);

  const triggers = inferTriggers(name, description);

  const frontmatter = buildAntigravityFrontmatter({
    description,
    format: 'skill',
    triggers,
  });

  return {
    name,
    filename: `${name}.md`,
    content: `${frontmatter}\n${converted}`,
  };
}

// ============================================================
// Helpers
// ============================================================

function buildAntigravityFrontmatter({ description, format, triggers }) {
  const lines = ['---', `description: ${description}`];

  if (format === 'skill' && triggers && triggers.length > 0) {
    lines.push('triggers:');
    for (const t of triggers) {
      lines.push(`  - "${t}"`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Infer auto-trigger patterns from skill name and description.
 */
export function inferTriggers(name, description) {
  const triggers = [];
  const n = name.toLowerCase();

  if (n.includes('plan-review')) {
    triggers.push('plan file created or modified');
    triggers.push('user mentions plan review');
  } else if (n.includes('impl-review')) {
    triggers.push('uncommitted changes detected');
    triggers.push('user preparing to commit');
  } else if (n.includes('commit-review')) {
    triggers.push('recent commits before push');
    triggers.push('user mentions commit review');
  } else if (n.includes('pr-review')) {
    triggers.push('feature branch with commits');
    triggers.push('user preparing pull request');
  } else if (n.includes('think-about')) {
    triggers.push('technical question or architecture debate');
    triggers.push('user asks for design advice');
  } else if (n.includes('parallel-review')) {
    triggers.push('user requests parallel review');
  } else if (n.includes('codebase-review')) {
    triggers.push('user requests full codebase review');
    triggers.push('large codebase needing review');
  } else if (n.includes('security-review')) {
    triggers.push('security-sensitive code detected');
    triggers.push('auth, SQL, crypto, or secrets code modified');
  }

  return triggers;
}

/**
 * Adapt Claude Code-specific references in the body to Antigravity equivalents.
 */
export function adaptReferences(body) {
  let result = body;

  // Replace "Claude Code" references with "Antigravity"
  result = result.replace(/\bClaude Code\b/g, 'Antigravity');

  // Replace ~/.claude/ paths with Antigravity equivalents
  result = result.replace(/~\/\.claude\/skills\//g, '~/.gemini/antigravity/skills/');
  result = result.replace(/~\/\.claude\/CLAUDE\.md/g, '~/.gemini/settings.json');

  return result;
}

// ============================================================
// Batch conversion
// ============================================================

/**
 * Convert all SKILL.md files in a skill-pack directory.
 *
 * @param {string} inputDir  - Path to skill-packs/codex-review/skills/
 * @param {string} outputDir - Output directory for converted files
 * @param {string} format    - 'commands' or 'skills'
 * @returns {Array<{name, inputPath, outputPath}>} conversion results
 */
export function convertAll(inputDir, outputDir, format = 'commands') {
  const convertFn = format === 'skills' ? convertToSkill : convertToCommand;
  const results = [];

  const entries = fs.readdirSync(inputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(inputDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, 'utf8');
    const converted = convertFn(content);

    // Write converted SKILL.md
    const outSkillDir = path.join(outputDir, entry.name);
    fs.mkdirSync(outSkillDir, { recursive: true });
    fs.writeFileSync(path.join(outSkillDir, 'SKILL.md'), converted.content, 'utf8');

    // Copy references/ directory as-is
    const refsDir = path.join(inputDir, entry.name, 'references');
    if (fs.existsSync(refsDir)) {
      copyDirSync(refsDir, path.join(outSkillDir, 'references'));
    }

    results.push({
      name: converted.name,
      inputPath: skillMdPath,
      outputPath: path.join(outSkillDir, 'SKILL.md'),
    });
  }

  return results;
}

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

// ============================================================
// CLI
// ============================================================

function printUsage() {
  console.log('Usage: node tools/antigravity-converter.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --format <commands|skills>  Target format (default: commands)');
  console.log('  --input <dir>              Input skill-packs/codex-review/skills/ directory');
  console.log('  --output <dir>             Output directory');
  console.log('  --help                     Show this help');
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  let format = 'commands';
  let inputDir = null;
  let outputDir = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--format' && argv[i + 1]) {
      format = argv[++i];
    } else if (argv[i] === '--input' && argv[i + 1]) {
      inputDir = argv[++i];
    } else if (argv[i] === '--output' && argv[i + 1]) {
      outputDir = argv[++i];
    }
  }

  if (!['commands', 'skills'].includes(format)) {
    console.error(`Error: invalid format "${format}". Must be "commands" or "skills".`);
    process.exit(1);
  }

  // Default input: skill-packs/codex-review/skills/ relative to repo root
  if (!inputDir) {
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    inputDir = path.resolve(scriptDir, '..', 'skill-packs', 'codex-review', 'skills');
  }

  if (!outputDir) {
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    outputDir = path.resolve(scriptDir, '..', 'dist', 'antigravity', format);
  }

  if (!fs.existsSync(inputDir)) {
    console.error(`Error: input directory not found: ${inputDir}`);
    process.exit(1);
  }

  console.log(`Converting SKILL.md templates to Antigravity ${format} format...`);
  console.log(`  Input:  ${inputDir}`);
  console.log(`  Output: ${outputDir}`);
  console.log('');

  const results = convertAll(inputDir, outputDir, format);

  for (const r of results) {
    console.log(`  ✓ ${r.name}`);
  }

  console.log('');
  console.log(`Converted ${results.length} skills to Antigravity ${format} format.`);
}

// Run CLI if executed directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main();
}
