#!/usr/bin/env node

/**
 * codex-runner.js — Cross-platform toolkit for Codex CLI review skills.
 *
 * Subcommands: version, start, poll, stop, detect, _watchdog
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// --- Constants ---
const CODEX_RUNNER_VERSION = 12;

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_TIMEOUT = 2;
const EXIT_TURN_FAILED = 3;
const EXIT_STALLED = 4;
const EXIT_CODEX_NOT_FOUND = 5;
const EXIT_GIT_NOT_FOUND = 6;

const IS_WIN = process.platform === "win32";

// --- Detection Engine Constants ---
const SOURCE_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs",
  ".java", ".cs", ".rb", ".php", ".vue", ".svelte",
]);

const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "vendor",
  "__pycache__", ".next", ".nuxt", "coverage",
]);

const SECURITY_PATTERNS = [
  // OWASP A01:2021 - Broken Access Control
  { regex: /(?:admin|superuser|root|elevated)\s*[:=]\s*(?:true|1|"true")/i, score: 35, reason: "hardcoded privilege escalation", owasp: "A01:2021", cwe: "CWE-284" },
  { regex: /(?:is_admin|is_superuser|has_permission)\s*=\s*True/i, score: 30, reason: "hardcoded admin flag", owasp: "A01:2021", cwe: "CWE-284" },
  { regex: /\.authorize\(\s*\)|\.skip_authorization|skip_before_action\s+:authorize/i, score: 25, reason: "authorization bypass", owasp: "A01:2021", cwe: "CWE-862" },
  
  // OWASP A02:2021 - Cryptographic Failures
  { regex: /\bmd5\s*\(|hashlib\.md5|crypto\.createHash\(['"]md5['"]\)/i, score: 35, reason: "weak hash algorithm (MD5)", owasp: "A02:2021", cwe: "CWE-327" },
  { regex: /\bsha1\s*\(|hashlib\.sha1|crypto\.createHash\(['"]sha1['"]\)/i, score: 30, reason: "weak hash algorithm (SHA1)", owasp: "A02:2021", cwe: "CWE-327" },
  { regex: /DES|3DES|RC4|Blowfish/i, score: 40, reason: "weak encryption algorithm", owasp: "A02:2021", cwe: "CWE-327" },
  { regex: /Math\.random\(\)|rand\(\)|random\.randint/i, score: 20, reason: "insecure random number generator", owasp: "A02:2021", cwe: "CWE-338" },
  { regex: /(?:password|secret|key)\s*=\s*['"]\w+['"]/i, score: 40, reason: "hardcoded password/secret", owasp: "A02:2021", cwe: "CWE-798" },
  
  // OWASP A03:2021 - Injection
  { regex: /SELECT\s.+FROM|INSERT\s+INTO|UPDATE\s.+SET|DELETE\s+FROM/i, score: 30, reason: "SQL query strings", owasp: "A03:2021", cwe: "CWE-89" },
  { regex: /execute\s*\(\s*['"]\s*SELECT|cursor\.execute\s*\(\s*f['"]/i, score: 40, reason: "SQL injection risk (string formatting)", owasp: "A03:2021", cwe: "CWE-89" },
  { regex: /\beval\s*\(|\bexec\s*\(|\bnew\s+Function\s*\(/i, score: 40, reason: "code injection risk (eval/exec)", owasp: "A03:2021", cwe: "CWE-95" },
  { regex: /exec\(.*\+.*\)|system\(.*\+.*\)|shell_exec|passthru/i, score: 45, reason: "command injection risk", owasp: "A03:2021", cwe: "CWE-78" },
  { regex: /subprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True/i, score: 40, reason: "shell injection risk (shell=True)", owasp: "A03:2021", cwe: "CWE-78" },
  { regex: /os\.system\s*\(|commands\.getoutput/i, score: 35, reason: "OS command execution", owasp: "A03:2021", cwe: "CWE-78" },
  { regex: /innerHTML|dangerouslySetInnerHTML|v-html|\{\{\{/i, score: 30, reason: "HTML/XSS injection risk", owasp: "A03:2021", cwe: "CWE-79" },
  { regex: /document\.write\s*\(|\.html\s*\(.*\+|\.append\s*\(.*\+/i, score: 25, reason: "DOM-based XSS risk", owasp: "A03:2021", cwe: "CWE-79" },
  { regex: /LDAP|ldap\.search|LdapConnection/i, score: 25, reason: "LDAP injection risk", owasp: "A03:2021", cwe: "CWE-90" },
  { regex: /XPath|xpath\.evaluate|selectNodes/i, score: 25, reason: "XPath injection risk", owasp: "A03:2021", cwe: "CWE-643" },
  
  // OWASP A04:2021 - Insecure Design
  { regex: /(?:rate_limit|throttle)\s*=\s*(?:false|0|None)/i, score: 20, reason: "rate limiting disabled", owasp: "A04:2021", cwe: "CWE-770" },
  { regex: /max_attempts\s*=\s*(?:999|9999|\d{4,})/i, score: 15, reason: "excessive retry attempts", owasp: "A04:2021", cwe: "CWE-307" },
  
  // OWASP A05:2021 - Security Misconfiguration
  { regex: /DEBUG\s*=\s*True|debug\s*[:=]\s*true/i, score: 25, reason: "debug mode enabled", owasp: "A05:2021", cwe: "CWE-489" },
  { regex: /ALLOWED_HOSTS\s*=\s*\[\s*['"]\*['"]\s*\]/i, score: 30, reason: "wildcard allowed hosts", owasp: "A05:2021", cwe: "CWE-942" },
  { regex: /cors\s*\(\s*\{\s*origin\s*:\s*['"]\*['"]/i, score: 30, reason: "CORS wildcard origin", owasp: "A05:2021", cwe: "CWE-942" },
  { regex: /X-Frame-Options|Content-Security-Policy|Strict-Transport-Security/i, score: 15, reason: "security headers configuration", owasp: "A05:2021", cwe: "CWE-693" },
  { regex: /verify\s*[:=]\s*(?:false|False|0)|SSL_VERIFY\s*=\s*False/i, score: 35, reason: "SSL verification disabled", owasp: "A05:2021", cwe: "CWE-295" },
  
  // OWASP A06:2021 - Vulnerable and Outdated Components
  { regex: /npm\s+install|pip\s+install|gem\s+install/i, score: 10, reason: "dependency installation", owasp: "A06:2021", cwe: "CWE-1104" },
  
  // OWASP A07:2021 - Identification and Authentication Failures
  { regex: /(?:password|secret|api[_-]?key|token|credential|auth)\s*[:=]/i, score: 25, reason: "auth/password patterns", owasp: "A07:2021", cwe: "CWE-798" },
  { regex: /session\.cookie_secure\s*=\s*False|SESSION_COOKIE_SECURE\s*=\s*False/i, score: 30, reason: "insecure session cookie", owasp: "A07:2021", cwe: "CWE-614" },
  { regex: /session\.cookie_httponly\s*=\s*False|httpOnly\s*:\s*false/i, score: 25, reason: "HttpOnly flag disabled", owasp: "A07:2021", cwe: "CWE-1004" },
  { regex: /bcrypt|scrypt|argon2|PBKDF2/i, score: 15, reason: "password hashing (good practice)", owasp: "A07:2021", cwe: "CWE-916" },
  { regex: /jwt\.decode\s*\([^)]*verify\s*=\s*False/i, score: 40, reason: "JWT signature verification disabled", owasp: "A07:2021", cwe: "CWE-347" },
  { regex: /(?:login|signin|authenticate).*(?:sleep|delay|setTimeout)/i, score: 20, reason: "timing attack vulnerability", owasp: "A07:2021", cwe: "CWE-208" },
  
  // OWASP A08:2021 - Software and Data Integrity Failures
  { regex: /pickle\.loads|yaml\.load\s*\(|eval\s*\(/i, score: 40, reason: "insecure deserialization", owasp: "A08:2021", cwe: "CWE-502" },
  { regex: /unserialize\s*\(|__wakeup|__destruct/i, score: 35, reason: "PHP deserialization risk", owasp: "A08:2021", cwe: "CWE-502" },
  { regex: /ObjectInputStream|readObject\s*\(/i, score: 35, reason: "Java deserialization risk", owasp: "A08:2021", cwe: "CWE-502" },
  
  // OWASP A09:2021 - Security Logging and Monitoring Failures
  { regex: /console\.log\s*\(.*(?:password|token|secret|key)/i, score: 30, reason: "sensitive data in logs", owasp: "A09:2021", cwe: "CWE-532" },
  { regex: /logger\.(?:debug|info)\s*\(.*(?:password|token|secret)/i, score: 30, reason: "sensitive data in logs", owasp: "A09:2021", cwe: "CWE-532" },
  { regex: /print\s*\(.*(?:password|token|secret|key)/i, score: 25, reason: "sensitive data in output", owasp: "A09:2021", cwe: "CWE-532" },
  
  // OWASP A10:2021 - Server-Side Request Forgery (SSRF)
  { regex: /requests\.get\s*\(.*\+|fetch\s*\(.*\+|urllib\.request/i, score: 25, reason: "SSRF risk (user-controlled URL)", owasp: "A10:2021", cwe: "CWE-918" },
  { regex: /http\.request\s*\(|https\.request\s*\(/i, score: 20, reason: "HTTP request (potential SSRF)", owasp: "A10:2021", cwe: "CWE-918" },
  
  // Additional Security Patterns
  { regex: /\b(?:crypto|createHash|createCipher|encrypt|decrypt)\b/i, score: 15, reason: "cryptographic operations", owasp: "A02:2021", cwe: "CWE-327" },
  { regex: /req\.body|req\.params|req\.query|request\.form|request\.args/i, score: 20, reason: "user input handling", owasp: "A03:2021", cwe: "CWE-20" },
  { regex: /\.env|process\.env|os\.environ|getenv/i, score: 15, reason: "environment variable access", owasp: "A05:2021", cwe: "CWE-526" },
  { regex: /file_get_contents|readFile|fs\.read|open\s*\(/i, score: 20, reason: "file operations", owasp: "A01:2021", cwe: "CWE-22" },
  { regex: /\.\.\//i, score: 35, reason: "path traversal pattern", owasp: "A01:2021", cwe: "CWE-22" },
  { regex: /chmod\s+777|chmod\s*\(\s*0777/i, score: 30, reason: "overly permissive file permissions", owasp: "A05:2021", cwe: "CWE-732" },
  { regex: /tmp|temp|\/var\/tmp/i, score: 15, reason: "temporary file usage", owasp: "A01:2021", cwe: "CWE-377" },
  { regex: /setuid|setgid|sudo/i, score: 25, reason: "privilege escalation operations", owasp: "A01:2021", cwe: "CWE-250" },
];

const SECURITY_FILE_EXTENSIONS = new Set([".sql", ".prisma", ".graphql"]);
const SECURITY_CONFIG_FILES = new Set(["docker-compose.yml", "docker-compose.yaml", "nginx.conf", "Dockerfile"]);

const PLAN_FILE_PATTERNS = ["plan.md", "PLAN.md"];
const PLAN_GLOB_PATTERN = /(?:^|\/)docs\/.*plan/i;
const PLAN_SUFFIX = ".plan.md";

// ============================================================
// Output Format Converters
// ============================================================

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSeverity(rawSeverity) {
  if (!rawSeverity) return "";
  const sev = String(rawSeverity).trim().toLowerCase();
  const map = {
    critical: "critical",
    blocker: "critical",
    high: "high",
    error: "high",
    medium: "medium",
    warning: "medium",
    warn: "medium",
    low: "low",
    note: "low",
    minor: "low",
    info: "info",
    informational: "info",
  };
  return map[sev] || sev;
}

function normalizeConfidence(rawConfidence) {
  if (!rawConfidence) return "";
  const conf = String(rawConfidence).trim().toLowerCase();
  if (conf.startsWith("high")) return "high";
  if (conf.startsWith("med")) return "medium";
  if (conf.startsWith("low")) return "low";
  return conf;
}

function stripInlineCode(raw) {
  if (!raw) return "";
  const text = String(raw).trim();
  if (text.startsWith("`") && text.endsWith("`")) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function parseLabeledSections(block) {
  const sections = {};
  const lines = String(block || "").split(/\r?\n/);
  let current = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (current) sections[current].push(line);
      continue;
    }

    if (!inFence) {
      const m = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?([A-Za-z][A-Za-z0-9 _/-]*?)(?:\*\*)?\s*:\s*(.*)\s*$/);
      if (m) {
        current = m[1].trim().toLowerCase().replace(/\s+/g, " ");
        if (!sections[current]) sections[current] = [];
        if (m[2]) sections[current].push(m[2]);
        continue;
      }
    }

    if (current) sections[current].push(line);
  }

  const out = {};
  for (const [k, parts] of Object.entries(sections)) {
    const value = parts.join("\n").trim();
    if (value) out[k] = value;
  }
  return out;
}

function getSectionValue(sections, aliases) {
  for (const alias of aliases) {
    const key = alias.toLowerCase().trim().replace(/\s+/g, " ");
    if (sections[key]) return sections[key];
  }
  return "";
}

function extractTextAndFirstCode(sectionText) {
  const text = String(sectionText || "").trim();
  if (!text) return { text: "", code: "" };

  const codeMatch = text.match(/```[^\n]*\n([\s\S]*?)```/);
  const code = codeMatch ? codeMatch[1].trim() : "";
  const withoutCode = text.replace(/```[^\n]*\n[\s\S]*?```/g, "").trim();
  const cleaned = withoutCode.replace(/^\s*[-*]\s*/gm, "").trim();
  return { text: cleaned, code };
}

function parseLocation(rawLocation, rawFile) {
  const locationText = stripInlineCode(rawLocation);
  const fileText = stripInlineCode(rawFile);

  const locMatch = locationText.match(/^(.*):(\d+)(?:-(\d+))?(?::(\d+)(?:-(\d+))?)?$/);
  if (locMatch) {
    const file = locMatch[1].trim();
    const startLine = parseInt(locMatch[2], 10);
    const endLine = locMatch[3] ? parseInt(locMatch[3], 10) : startLine;
    const startColumn = locMatch[4] ? parseInt(locMatch[4], 10) : undefined;
    const endColumn = locMatch[5] ? parseInt(locMatch[5], 10) : undefined;

    const location = {
      file,
      start_line: startLine,
      end_line: endLine,
    };
    if (startColumn) location.start_column = startColumn;
    if (endColumn) location.end_column = endColumn;
    return location;
  }

  if (fileText) return { file: fileText };
  if (locationText) return { file: locationText };
  return null;
}

function buildOwaspUrl(owaspId) {
  const base = String(owaspId || "").toUpperCase();
  if (!base) return "";
  return `https://owasp.org/Top10/${base.replace(":", "_")}/`;
}

function extractExternalRefs(block, sections) {
  const refs = [];
  const cweSeen = new Set();
  const owaspSeen = new Set();
  const sources = [
    String(block || ""),
    getSectionValue(sections, ["cwe"]),
    getSectionValue(sections, ["owasp"]),
  ].join("\n");

  const cweRegex = /\bCWE-(\d{1,5})\b/gi;
  for (const m of sources.matchAll(cweRegex)) {
    const idNum = m[1];
    const id = `CWE-${idNum}`;
    if (cweSeen.has(id)) continue;
    cweSeen.add(id);
    refs.push({
      type: "cwe",
      id,
      url: `https://cwe.mitre.org/data/definitions/${idNum}.html`,
    });
  }

  const owaspRegex = /\bA\d{2}:\d{4}\b/gi;
  for (const m of sources.matchAll(owaspRegex)) {
    const id = m[0].toUpperCase();
    if (owaspSeen.has(id)) continue;
    owaspSeen.add(id);
    refs.push({
      type: "owasp",
      id,
      url: buildOwaspUrl(id),
    });
  }

  return refs;
}

function parseBulletList(sectionText) {
  if (!sectionText) return [];
  const items = [];
  for (const line of String(sectionText).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)\s*$/);
    if (m) items.push(m[1].trim());
  }
  return items;
}

function buildSarifErrorDocument(message, canonicalJSON) {
  const toolName = canonicalJSON?.tool?.name || "codex-review";
  const toolVersion = canonicalJSON?.tool?.version || String(CODEX_RUNNER_VERSION);
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: toolName,
          version: toolVersion,
          rules: [{
            id: "codex-review/conversion-error",
            shortDescription: { text: "Review conversion error" },
            fullDescription: { text: "Failed to convert review output to requested format." },
          }],
        },
      },
      results: [{
        ruleId: "codex-review/conversion-error",
        level: "error",
        message: {
          text: `Failed to convert review output to SARIF: ${String(message || "unknown error")}`,
        },
      }],
    }],
  };
}

/**
 * Parse Codex markdown output and convert to canonical JSON schema.
 * See docs/CANONICAL_JSON_SCHEMA.md for full specification.
 * 
 * @param {string} markdownOutput - Raw markdown from Codex
 * @param {object} metadata - Review metadata (skill, effort, etc.)
 * @returns {object} Canonical JSON review object
 */
function parseToCanonicalJSON(markdownOutput, metadata) {
  const text = String(markdownOutput || "");
  const meta = metadata || {};
  const findings = [];
  let verdict = null;

  // Supports:
  // - ## ISSUE-1: ...
  // - ### ISSUE-1: ...
  // - ISSUE-1: ...
  // - RESPONSE-1: ...
  const findingRegex = /^\s*(?:#{2,3}\s*)?(ISSUE-\d+|PERSPECTIVE-\d+|CROSS-\d+|RESPONSE-\d+)\s*:\s*(.+?)\s*$/gim;
  const matches = [...text.matchAll(findingRegex)];

  const verdictHeaderRegex = /^\s*(?:#{2,3}\s*)?VERDICT(?:\s*:\s*([A-Za-z|/\-\s]+))?\s*$/im;
  const verdictHeaderMatch = verdictHeaderRegex.exec(text);
  const verdictStart = verdictHeaderMatch ? verdictHeaderMatch.index : -1;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const id = String(match[1]).toUpperCase();
    const title = String(match[2] || "").trim();
    const startIdx = match.index + match[0].length;

    let endIdx;
    if (i < matches.length - 1) {
      endIdx = matches[i + 1].index;
    } else if (verdictStart >= 0 && verdictStart > startIdx) {
      endIdx = verdictStart;
    }

    const block = text.slice(startIdx, endIdx);
    const sections = parseLabeledSections(block);

    let type = "issue";
    if (id.startsWith("PERSPECTIVE-")) type = "perspective";
    if (id.startsWith("CROSS-")) type = "cross-cutting";
    if (id.startsWith("RESPONSE-")) type = "response";

    const finding = { id, type, title };

    const category = getSectionValue(sections, ["category"]);
    const severityRaw = getSectionValue(sections, ["severity"]);
    const confidenceRaw = getSectionValue(sections, ["confidence"]);
    const statusRaw = getSectionValue(sections, ["status"]);
    const fileRaw = getSectionValue(sections, ["file"]);
    const locationRaw = getSectionValue(sections, ["location"]);

    if (category) finding.category = category.trim().toLowerCase();
    if (severityRaw) {
      finding.raw_severity = severityRaw.trim().toLowerCase();
      finding.severity = normalizeSeverity(severityRaw);
    }
    if (confidenceRaw) finding.confidence = normalizeConfidence(confidenceRaw);
    if (statusRaw) finding.status = statusRaw.trim().toLowerCase();

    const parsedLocation = parseLocation(locationRaw, fileRaw);
    if (parsedLocation) finding.location = parsedLocation;

    const problem = getSectionValue(sections, ["problem", "why it matters", "implications", "content"]);
    if (problem) finding.problem = problem.trim();

    const evidence = getSectionValue(sections, ["evidence"]);
    if (evidence) {
      const parsedEvidence = extractTextAndFirstCode(evidence);
      finding.evidence = {};
      if (parsedEvidence.code) finding.evidence.code_snippet = parsedEvidence.code;
      if (parsedEvidence.text) finding.evidence.context = parsedEvidence.text;
      if (!finding.evidence.code_snippet && !finding.evidence.context) {
        delete finding.evidence;
      }
    }

    // Suggested fix parsing: section parse first, then fallback regex.
    let suggestedFixSection = getSectionValue(sections, ["suggested fix", "suggested_fix", "fix"]);
    if (!suggestedFixSection) {
      const knownLabels = [
        "Category", "Severity", "Confidence", "File", "Location", "Problem",
        "Evidence", "Attack Vector", "CWE", "OWASP", "Status", "Suggested Fix",
      ];
      const stopPattern = knownLabels.map((label) => escapeRegExp(label)).join("|");
      const fixRegex = new RegExp(
        `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?Suggested\\s*Fix(?:\\*\\*)?\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${stopPattern})(?:\\*\\*)?\\s*:|\\n\\s*(?:#{2,3}\\s*)?(?:ISSUE-\\d+|PERSPECTIVE-\\d+|CROSS-\\d+|RESPONSE-\\d+|VERDICT\\b)|$)`,
        "im"
      );
      const fallbackFixMatch = block.match(fixRegex);
      suggestedFixSection = fallbackFixMatch ? fallbackFixMatch[1] : "";
    }
    if (suggestedFixSection) {
      const parsedFix = extractTextAndFirstCode(suggestedFixSection);
      finding.suggested_fix = {};
      if (parsedFix.text) finding.suggested_fix.description = parsedFix.text;
      if (parsedFix.code) finding.suggested_fix.code = parsedFix.code;
      if (!finding.suggested_fix.description && finding.suggested_fix.code) {
        finding.suggested_fix.description = "Apply the suggested code change.";
      }
      if (!finding.suggested_fix.description && !finding.suggested_fix.code) {
        delete finding.suggested_fix;
      }
    }

    const refs = extractExternalRefs(block, sections);
    if (refs.length > 0) finding.external_refs = refs;

    // Default status and confidence (but not for response type)
    if (!finding.status && type !== "response") finding.status = "open";
    if (!finding.confidence) finding.confidence = "medium";

    if (type !== "issue") {
      const content = getSectionValue(sections, ["content", "problem", "evidence"]);
      const pattern = getSectionValue(sections, ["pattern"]);
      if (content && !finding.content) finding.content = content.trim();
      if (pattern) finding.pattern = pattern.trim();
    }

    // RESPONSE-specific fields (for parallel-review debate phase)
    if (type === "response") {
      const action = getSectionValue(sections, ["action"]);
      const reason = getSectionValue(sections, ["reason"]);
      if (action) {
        const normalizedAction = action.trim().toLowerCase();
        // Validate action against allowed values
        if (["accept", "reject", "revise"].includes(normalizedAction)) {
          finding.action = normalizedAction;
        } else {
          // Keep raw_action but don't set action to invalid value
          finding.raw_action = action.trim();
          finding.action_valid = false;
        }
      }
      if (reason) finding.reason = reason.trim();
      
      // Extract target from title (format: "Re: {original finding title}")
      const targetMatch = title.match(/^Re:\s*(.+)$/i);
      if (targetMatch) finding.target = targetMatch[1].trim();
      
      // Parse optional revised_finding (for action=revise)
      const revisedDesc = getSectionValue(sections, ["revised finding", "revised_finding"]);
      if (revisedDesc) {
        finding.revised_finding = { description: revisedDesc.trim() };
        // Check for revised fix within the section
        const revisedFix = getSectionValue(sections, ["revised fix", "revised_fix"]);
        if (revisedFix) {
          const parsedRevisedFix = extractTextAndFirstCode(revisedFix);
          finding.revised_finding.suggested_fix = {};
          if (parsedRevisedFix.text) finding.revised_finding.suggested_fix.description = parsedRevisedFix.text;
          if (parsedRevisedFix.code) finding.revised_finding.suggested_fix.code = parsedRevisedFix.code;
        }
      }
      
      // Parse optional counter_evidence (for action=reject)
      const counterEvidence = getSectionValue(sections, ["counter evidence", "counter_evidence", "counter-evidence"]);
      if (counterEvidence) finding.counter_evidence = counterEvidence.trim();
    }

    findings.push(finding);
  }

  if (verdictHeaderMatch) {
    let verdictType = String(verdictHeaderMatch[1] || "").trim().toUpperCase();
    if (verdictType.includes("|")) verdictType = "";

    const verdictBlockStart = verdictHeaderMatch.index + verdictHeaderMatch[0].length;
    const verdictText = text.slice(verdictBlockStart).trim();
    const verdictSections = parseLabeledSections(verdictText);

    if (!verdictType) {
      const statusRaw = getSectionValue(verdictSections, ["status", "verdict"]);
      const statusMatch = statusRaw.match(/\b(APPROVE|REVISE|COMMENT|STALEMATE)\b/i);
      if (statusMatch) verdictType = statusMatch[1].toUpperCase();
    }
    if (!verdictType) {
      const fallbackType = verdictText.match(/\b(APPROVE|REVISE|COMMENT|STALEMATE)\b/i);
      if (fallbackType) verdictType = fallbackType[1].toUpperCase();
    }
    if (!verdictType) verdictType = "COMMENT";

    let reason = getSectionValue(verdictSections, ["reason"]);
    if (!reason) {
      const rawLines = verdictText.split(/\r?\n/);
      const filtered = rawLines.filter((line) => {
        return !/^\s*(?:[-*]\s*)?(?:\*\*)?(status|reason|security risk summary|risk assessment|recommendations|blocking issues|advisory issues|conditions|next steps)(?:\*\*)?\s*:/i.test(line);
      });
      reason = filtered.join("\n").trim();
    }

    const conditionsText = getSectionValue(verdictSections, ["conditions", "blocking issues"]);
    const nextStepsText = getSectionValue(verdictSections, ["next steps", "recommendations", "advisory issues"]);
    const conditions = parseBulletList(conditionsText);
    const nextSteps = parseBulletList(nextStepsText);

    verdict = {
      verdict: verdictType,
      reason: reason || verdictText || "No additional reason provided.",
    };
    if (conditions.length > 0) verdict.conditions = conditions;
    if (nextSteps.length > 0) verdict.next_steps = nextSteps;
  }

  const reviewVerdict = verdict?.verdict || "COMMENT";
  const reviewStatus = reviewVerdict === "STALEMATE" ? "stalemate" : "complete";

  return {
    schema_version: "1.0.0",
    tool: {
      name: "codex-review",
      version: String(CODEX_RUNNER_VERSION),
      skill: meta.skill || "unknown",
      invocation: {
        working_dir: meta.working_dir || process.cwd(),
        effort: meta.effort || "medium",
        mode: meta.mode || "unknown",
        timestamp: new Date().toISOString(),
        thread_id: meta.thread_id || null,
      },
    },
    review: {
      verdict: reviewVerdict,
      status: reviewStatus,
      round: meta.round || 1,
      summary: {
        files_reviewed: meta.files_reviewed || 0,
        issues_found: findings.filter(f => f.type === 'issue').length,
        issues_fixed: 0,
        issues_disputed: 0,
      },
    },
    findings,
    verdict,
    metadata: {
      duration_seconds: meta.duration_seconds || meta.elapsed_seconds || 0,
      tokens_used: meta.tokens_used || 0,
      model: meta.model || "gpt-5.3-codex",
    },
  };
}

/**
 * Convert canonical JSON to SARIF 2.1.0 format.
 * See docs/CANONICAL_JSON_SCHEMA.md for mapping rules.
 * 
 * @param {object} canonicalJSON - Review in canonical format
 * @returns {object} SARIF 2.1.0 compliant object
 */
function convertToSARIF(canonicalJSON) {
  const severityToLevel = {
    critical: "error",
    high: "error",
    error: "error",
    medium: "warning",
    warning: "warning",
    low: "note",
    note: "note",
    info: "none",
  };
  
  // Build unique rules from findings
  const rulesMap = new Map();
  const results = [];
  
  for (const finding of canonicalJSON.findings) {
    // Skip non-issue findings (PERSPECTIVE, CROSS, RESPONSE) for SARIF
    if (finding.type !== 'issue') continue;
    
    const normalizedSeverity = normalizeSeverity(finding.severity || finding.raw_severity);
    const normalizedCategory = String(finding.category || "review-finding")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-");
    const ruleId = `${normalizedCategory}/${String(finding.id || "issue").toLowerCase()}`;
    
    // Create rule if not exists
    if (!rulesMap.has(ruleId)) {
      rulesMap.set(ruleId, {
        id: ruleId,
        shortDescription: { text: finding.category || "Review Finding" },
        fullDescription: { text: finding.title },
        helpUri: finding.external_refs?.[0]?.url || undefined
      });
    }
    
    // Build SARIF result
    const result = {
      ruleId,
      ruleIndex: Array.from(rulesMap.keys()).indexOf(ruleId),
      level: severityToLevel[normalizedSeverity] || "warning",
      message: { text: finding.title || finding.problem || "Review finding" }
    };
    
    // Add location if available
    if (finding.location?.file) {
      const region = {};
      if (Number.isInteger(finding.location.start_line)) region.startLine = finding.location.start_line;
      if (Number.isInteger(finding.location.end_line)) region.endLine = finding.location.end_line;
      if (Number.isInteger(finding.location.start_column)) region.startColumn = finding.location.start_column;
      if (Number.isInteger(finding.location.end_column)) region.endColumn = finding.location.end_column;

      const physicalLocation = {
        artifactLocation: { uri: finding.location.file },
      };
      if (Object.keys(region).length > 0) {
        physicalLocation.region = region;
      }

      result.locations = [{
        physicalLocation
      }];
    }
    
    // Add fixes if available
    if (finding.suggested_fix?.code && finding.location?.file) {
      result.fixes = [{
        description: { text: finding.suggested_fix.description || "Apply suggested fix" },
        artifactChanges: [{
          artifactLocation: { uri: finding.location.file },
          replacements: [{
            deletedRegion: {
              startLine: finding.location?.start_line || 1,
              endLine: finding.location?.end_line || finding.location?.start_line || 1
            },
            insertedContent: { text: finding.suggested_fix.code }
          }]
        }]
      }];
    }
    
    // Add properties
    result.properties = {
      confidence: finding.confidence,
      category: finding.category,
      status: finding.status,
      normalized_severity: normalizedSeverity,
    };
    
    if (finding.external_refs) {
      result.properties.external_refs = finding.external_refs;
    }
    
    results.push(result);
  }
  
  // Build SARIF document
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: canonicalJSON.tool.name,
          version: canonicalJSON.tool.version,
          informationUri: "https://github.com/lploc94/codex_skill",
          rules: Array.from(rulesMap.values())
        }
      },
      results,
      invocations: [{
        executionSuccessful: canonicalJSON.review.status === "complete",
        workingDirectory: {
          uri: pathToFileURL(canonicalJSON.tool.invocation.working_dir || process.cwd()).href
        }
      }]
    }]
  };
}

/**
 * Convert canonical JSON to human-readable Markdown.
 * See docs/CANONICAL_JSON_SCHEMA.md for rendering guidelines.
 * 
 * @param {object} canonicalJSON - Review in canonical format
 * @returns {string} Formatted markdown string
 */
function convertToMarkdown(canonicalJSON) {
  const lines = [];
  
  // Header
  lines.push("# Code Review Results\n");
  lines.push(`**Verdict**: ${canonicalJSON.review.verdict}`);
  lines.push(`**Status**: ${canonicalJSON.review.status} (Round ${canonicalJSON.review.round})`);
  lines.push(`**Files Reviewed**: ${canonicalJSON.review.summary.files_reviewed}`);
  lines.push(`**Issues Found**: ${canonicalJSON.review.summary.issues_found} (${canonicalJSON.review.summary.issues_fixed} fixed, ${canonicalJSON.review.summary.issues_found - canonicalJSON.review.summary.issues_fixed} open)\n`);
  lines.push("---\n");
  
  // Group findings by severity
  const severityOrder = ["critical", "high", "medium", "low", "info"];
  const severityLabel = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    info: "Info"
  };
  
  const findingsBySeverity = {};
  const otherFindings = [];
  
  for (const finding of canonicalJSON.findings) {
    const severity = normalizeSeverity(finding.severity || finding.raw_severity);
    if (finding.type === "issue" && severity) {
      if (!findingsBySeverity[severity]) {
        findingsBySeverity[severity] = [];
      }
      findingsBySeverity[severity].push(finding);
    } else {
      otherFindings.push(finding);
    }
  }
  
  // Render findings by severity
  for (const severity of severityOrder) {
    const findings = findingsBySeverity[severity];
    if (!findings || findings.length === 0) continue;
    
    const label = severityLabel[severity] || severity;
    lines.push(`## ${label} Issues (${findings.length})\n`);
    
    for (const finding of findings) {
      lines.push(`### ${finding.id}: ${finding.title}`);
      lines.push(`- **Category**: ${finding.category}`);
      lines.push(`- **Severity**: ${severity}`);
      if (finding.location) {
        const loc = finding.location;
        const locStr = loc.start_line ? `${loc.file}:${loc.start_line}${loc.end_line && loc.end_line !== loc.start_line ? `-${loc.end_line}` : ''}` : loc.file;
        lines.push(`- **File**: \`${locStr}\``);
      }
      lines.push(`- **Confidence**: ${finding.confidence}`);
      if (finding.status) {
        lines.push(`- **Status**: ${finding.status}`);
      }
      lines.push("");
      
      if (finding.problem) {
        lines.push(`**Problem**: ${finding.problem}\n`);
      }
      
      if (finding.evidence?.code_snippet) {
        lines.push("**Evidence**:");
        lines.push("```");
        lines.push(finding.evidence.code_snippet);
        lines.push("```\n");
      } else if (finding.evidence?.context) {
        lines.push(`**Evidence**: ${finding.evidence.context}\n`);
      }
      
      if (finding.suggested_fix) {
        lines.push(`**Suggested Fix**: ${finding.suggested_fix.description}`);
        if (finding.suggested_fix.code) {
          lines.push("```");
          lines.push(finding.suggested_fix.code);
          lines.push("```");
        }
        lines.push("");
      }
      
      if (finding.external_refs && finding.external_refs.length > 0) {
        lines.push("**References**:");
        for (const ref of finding.external_refs) {
          const label = ref.type === 'cwe' ? `CWE-${ref.id.replace('CWE-', '')}` : ref.id;
          lines.push(`- [${label}](${ref.url})`);
        }
        lines.push("");
      }
      
      lines.push("---\n");
    }
  }

  // Do not drop unknown severities.
  const unknownSeverities = Object.keys(findingsBySeverity).filter((sev) => !severityOrder.includes(sev));
  for (const severity of unknownSeverities) {
    const findings = findingsBySeverity[severity];
    if (!findings || findings.length === 0) continue;
    lines.push(`## ${severity} Issues (${findings.length})\n`);
    for (const finding of findings) {
      lines.push(`### ${finding.id}: ${finding.title}`);
      lines.push(`- **Category**: ${finding.category || "unknown"}`);
      lines.push(`- **Severity**: ${severity}`);
      lines.push(`- **Confidence**: ${finding.confidence || "medium"}`);
      lines.push("");
      if (finding.problem) lines.push(`**Problem**: ${finding.problem}\n`);
      lines.push("---\n");
    }
  }
  
  // Render other findings (PERSPECTIVE, CROSS, RESPONSE)
  if (otherFindings.length > 0) {
    lines.push("## Other Findings\n");
    for (const finding of otherFindings) {
      lines.push(`### ${finding.id}: ${finding.title}`);
      lines.push(`- **Type**: ${finding.type}`);
      lines.push(`- **Confidence**: ${finding.confidence}\n`);
      
      // RESPONSE-specific rendering
      if (finding.type === "response") {
        if (finding.action) {
          lines.push(`**Action**: ${finding.action}`);
        } else if (finding.raw_action) {
          lines.push(`**Action**: ${finding.raw_action} (invalid - must be accept/reject/revise)`);
        }
        if (finding.reason) lines.push(`**Reason**: ${finding.reason}`);
        if (finding.target) lines.push(`**Target**: ${finding.target}`);
        
        // Render revised_finding if action=revise
        if (finding.revised_finding) {
          lines.push("\n**Revised Finding**:");
          if (finding.revised_finding.description) {
            lines.push(finding.revised_finding.description);
          }
          if (finding.revised_finding.suggested_fix) {
            lines.push("\n**Revised Fix**:");
            if (finding.revised_finding.suggested_fix.description) {
              lines.push(finding.revised_finding.suggested_fix.description);
            }
            if (finding.revised_finding.suggested_fix.code) {
              lines.push("```");
              lines.push(finding.revised_finding.suggested_fix.code);
              lines.push("```");
            }
          }
        }
        
        // Render counter_evidence if action=reject
        if (finding.counter_evidence) {
          lines.push("\n**Counter Evidence**:");
          lines.push(finding.counter_evidence);
        }
        
        lines.push("");
      }
      
      if (finding.content) {
        lines.push(finding.content);
        lines.push("");
      }
      
      if (finding.pattern) {
        lines.push(`**Pattern**: ${finding.pattern}\n`);
      }
      
      lines.push("---\n");
    }
  }
  
  // Verdict section
  if (canonicalJSON.verdict) {
    lines.push("## Verdict\n");
    lines.push(`**${canonicalJSON.verdict.verdict}**\n`);
    lines.push(canonicalJSON.verdict.reason);
    lines.push("");
    
    if (canonicalJSON.verdict.conditions && canonicalJSON.verdict.conditions.length > 0) {
      lines.push("\n**Conditions**:");
      for (const condition of canonicalJSON.verdict.conditions) {
        lines.push(`- ${condition}`);
      }
      lines.push("");
    }
    
    if (canonicalJSON.verdict.next_steps && canonicalJSON.verdict.next_steps.length > 0) {
      lines.push("\n**Next Steps**:");
      for (const step of canonicalJSON.verdict.next_steps) {
        lines.push(`- ${step}`);
      }
      lines.push("");
    }
  }
  
  // Metadata footer
  lines.push("\n---\n");
  lines.push("**Review Metadata**:");
  lines.push(`- Skill: ${canonicalJSON.tool.skill}`);
  lines.push(`- Duration: ${canonicalJSON.metadata.duration_seconds}s`);
  lines.push(`- Model: ${canonicalJSON.metadata.model}`);
  lines.push(`- Timestamp: ${canonicalJSON.tool.invocation.timestamp}`);
  
  return lines.join('\n');
}

/**
 * Write review outputs in requested format(s).
 * 
 * @param {string} stateDir - State directory path
 * @param {string} markdownOutput - Raw Codex markdown output
 * @param {object} metadata - Review metadata
 * @param {string} format - Output format: markdown|json|sarif|both
 */
function writeReviewOutputs(stateDir, markdownOutput, metadata, format) {
  // Always write review.md (primary markdown output)
  atomicWrite(path.join(stateDir, "review.md"), markdownOutput);

  // If markdown only, we're done
  if (format === "markdown" || !format) {
    return;
  }

  // Convert to JSON/SARIF formats
  if (format === "json" || format === "sarif" || format === "both") {
    try {
      const canonicalJSON = parseToCanonicalJSON(markdownOutput, metadata);
      
      // Apply deduplication to findings (preserves higher confidence)
      if (canonicalJSON.findings && canonicalJSON.findings.length > 0) {
        const originalCount = canonicalJSON.findings.length;
        canonicalJSON.findings = deduplicateFindings(canonicalJSON.findings);
        const deduplicatedCount = canonicalJSON.findings.length;
        
        if (originalCount !== deduplicatedCount) {
          process.stderr.write(`[deduplication] Merged ${originalCount - deduplicatedCount} duplicate findings (${originalCount} → ${deduplicatedCount})\n`);
        }
        
        // Update summary counts after deduplication
        if (canonicalJSON.review && canonicalJSON.review.summary) {
          canonicalJSON.review.summary.issues_found = canonicalJSON.findings.filter(f => f.type === 'issue').length;
        }
      }

      // Write canonical JSON
      if (format === "json" || format === "both") {
        atomicWrite(
          path.join(stateDir, "review.json"),
          JSON.stringify(canonicalJSON, null, 2)
        );
      }

      // Write SARIF
      if (format === "sarif" || format === "both") {
        const sarif = convertToSARIF(canonicalJSON);
        atomicWrite(
          path.join(stateDir, "review.sarif.json"),
          JSON.stringify(sarif, null, 2)
        );
      }
    } catch (err) {
      // Fallback already written (review.md)
      process.stderr.write(`Warning: Format conversion failed: ${err.message}\n`);
      if (err && err.stack) process.stderr.write(`Stack trace: ${err.stack}\n`);

      // Write error placeholder
      const errorPlaceholder = {
        error: "Format conversion failed",
        message: err.message,
        requested_format: format,
        fallback: "review.md contains original markdown output"
      };

      if (format === "json" || format === "both") {
        atomicWrite(
          path.join(stateDir, "review.json"),
          JSON.stringify(errorPlaceholder, null, 2)
        );
      }

      if (format === "sarif" || format === "both") {
        const sarifError = buildSarifErrorDocument(err.message, {
          tool: {
            name: "codex-review",
            version: String(CODEX_RUNNER_VERSION),
          },
        });
        atomicWrite(
          path.join(stateDir, "review.sarif.json"),
          JSON.stringify(sarifError, null, 2)
        );
      }
    }
  }
}

/**
 * Deduplicate findings by merging similar issues while preserving higher confidence.
 * Only deduplicates actionable "issue" type findings with matching file + problem.
 * 
 * @param {Array} findings - Array of finding objects from canonical JSON
 * @returns {Array} Deduplicated findings with merged metadata
 */
function deduplicateFindings(findings) {
  if (!findings || findings.length === 0) return [];
  
  const groups = new Map(); // Key: type|file|problem, Value: array of findings
  const deduplicated = [];
  
  // Helper: normalize text for comparison
  function normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ");
  }
  
  // Helper: score finding detail level (for selecting most detailed)
  function scoreDetail(finding) {
    let score = 0;
    if (finding.location?.file) score += 10;
    if (finding.location?.start_line) score += 5;
    if (finding.problem) score += 20;
    if (finding.evidence?.code_snippet) score += 15;
    if (finding.suggested_fix?.code) score += 25;
    if (finding.suggested_fix?.description) score += 10;
    return score;
  }
  
  // Group findings by type + file + problem (only for actionable issues)
  for (const finding of findings) {
    // Only deduplicate "issue" type findings
    if (finding.type !== "issue") {
      deduplicated.push(finding);
      continue;
    }
    
    const fileKey = finding.location?.file?.toLowerCase().trim();
    const problemKey = normalizeText(finding.problem);
    
    // If missing file or problem, keep as-is (no dedup)
    if (!fileKey || !problemKey) {
      deduplicated.push(finding);
      continue;
    }
    
    const key = `${finding.type}|${fileKey}|${problemKey}`;
    
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(finding);
  }
  
  // Merge each group
  const confidenceOrder = { high: 3, medium: 2, low: 1 };
  const severityOrder = { critical: 5, high: 4, error: 4, medium: 3, warning: 3, low: 2, note: 1, info: 0 };
  
  for (const [_, group] of groups.entries()) {
    if (group.length === 1) {
      deduplicated.push(group[0]);
      continue;
    }
    
    // Sort by confidence (high > medium > low), then by severity
    group.sort((a, b) => {
      const confA = confidenceOrder[a.confidence] || 0;
      const confB = confidenceOrder[b.confidence] || 0;
      if (confA !== confB) return confB - confA;
      
      const sevA = severityOrder[normalizeSeverity(a.severity)] || 0;
      const sevB = severityOrder[normalizeSeverity(b.severity)] || 0;
      return sevB - sevA;
    });
    
    // Start with highest confidence finding
    const bestByConfidence = group[0];
    const merged = { ...bestByConfidence };
    
    // Find most detailed finding
    const mostDetailed = group
      .slice()
      .sort((a, b) => scoreDetail(b) - scoreDetail(a))[0];
    
    // Preserve detail fields from most detailed finding if missing in winner
    for (const field of ["location", "problem", "evidence", "suggested_fix", "category"]) {
      if (merged[field] == null && mostDetailed[field] != null) {
        merged[field] = mostDetailed[field];
      }
    }
    
    // Aggregate external_refs from all findings
    const allRefs = new Map();
    for (const finding of group) {
      if (finding.external_refs) {
        for (const ref of finding.external_refs) {
          const key = `${ref.type}:${ref.id || ref.url}`;
          if (!allRefs.has(key)) {
            allRefs.set(key, ref);
          }
        }
      }
    }
    if (allRefs.size > 0) {
      merged.external_refs = Array.from(allRefs.values());
    }
    
    // Aggregate related findings
    const allRelated = new Set();
    for (const finding of group) {
      if (finding.related) {
        for (const rel of finding.related) {
          allRelated.add(rel);
        }
      }
    }
    if (allRelated.size > 0) {
      merged.related = Array.from(allRelated);
    }
    
    // Add metadata about deduplication
    merged.deduplication_info = {
      merged_count: group.length,
      confidence_levels: group.map(f => f.confidence).filter((v, i, a) => a.indexOf(v) === i),
      sources: group.map(f => f.id).filter(Boolean)
    };
    
    deduplicated.push(merged);
  }
  
  return deduplicated;
}

// ============================================================
// Process management
// ============================================================

/**
 * Resolve the codex CLI command for spawning.
 *
 * On Windows, npm-installed CLIs are .cmd wrappers (e.g. codex.cmd).
 * Node.js spawn() cannot resolve .cmd files without shell: true,
 * but shell: true + detached: true drops stdio on Windows.
 * Instead, resolve the underlying codex.js entry point and invoke
 * it directly via node.exe — no shell needed.
 */
function resolveCodexCommand() {
  if (!IS_WIN) {
    return { cmd: "codex", prependArgs: [] };
  }

  // Try to find codex.js via npm global prefix
  const r = spawnSync("npm", ["config", "get", "prefix"], {
    encoding: "utf8",
    shell: true,
    timeout: 10000,
  });
  if (r.status === 0 && r.stdout) {
    const prefix = r.stdout.trim();
    const codexJs = path.join(
      prefix, "node_modules", "@openai", "codex", "bin", "codex.js",
    );
    if (fs.existsSync(codexJs)) {
      return { cmd: process.execPath, prependArgs: [codexJs] };
    }
  }

  // Fallback: try common npm global path on Windows
  const appData = process.env.APPDATA;
  if (appData) {
    const codexJs = path.join(
      appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js",
    );
    if (fs.existsSync(codexJs)) {
      return { cmd: process.execPath, prependArgs: [codexJs] };
    }
  }

  // Last resort: assume "codex" is directly executable (non-npm install)
  return { cmd: "codex", prependArgs: [] };
}

function launchCodex(stateDir, workingDir, timeoutS, threadId, effort, sandbox = "read-only") {
  const promptFile = path.join(stateDir, "prompt.txt");
  const jsonlFile = path.join(stateDir, "output.jsonl");
  const errFile = path.join(stateDir, "error.log");

  const { cmd: resolvedCmd, prependArgs } = resolveCodexCommand();
  let cmd = resolvedCmd;
  let args;
  let cwd;

  if (threadId) {
    args = [...prependArgs, "exec", "--skip-git-repo-check", "--json", "resume", threadId];
    cwd = workingDir;
  } else {
    args = [
      ...prependArgs,
      "exec", "--skip-git-repo-check", "--json",
      "--sandbox", sandbox,
      "--config", `model_reasoning_effort=${effort}`,
      "-C", workingDir,
    ];
    cwd = undefined;
  }

  const fin = fs.openSync(promptFile, "r");
  const fout = fs.openSync(jsonlFile, "w");
  const ferr = fs.openSync(errFile, "w");

  const spawnOpts = {
    stdio: [fin, fout, ferr],
    detached: true,
    cwd,
  };

  if (IS_WIN) {
    spawnOpts.windowsHide = true;
  }

  const child = spawn(cmd, args, spawnOpts);
  child.unref();

  const pid = child.pid;

  if (pid === undefined) {
    throw new Error(`Failed to spawn "${cmd}" — process did not start (ENOENT). Is codex installed globally?`);
  }

  // Close file descriptors in parent
  fs.closeSync(fin);
  fs.closeSync(fout);
  fs.closeSync(ferr);

  return { pid, pgid: pid };
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // Process already dead
  }
}

function killSingle(pid) {
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], {
        stdio: "ignore",
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process already dead
  }
}

function getCmdline(pid) {
  try {
    if (IS_WIN) {
      // Try PowerShell first
      try {
        const result = spawnSync(
          "powershell",
          ["-NoProfile", "-Command",
           `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { encoding: "utf8", timeout: 10000 },
        );
        const cmdline = (result.stdout || "").trim();
        if (cmdline) return cmdline;
      } catch {
        // PowerShell not available
      }
      // Fallback to wmic
      try {
        const result = spawnSync(
          "wmic",
          ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
          { encoding: "utf8", timeout: 5000 },
        );
        for (const line of (result.stdout || "").split("\n")) {
          if (line.startsWith("CommandLine=")) {
            return line.slice("CommandLine=".length).trim();
          }
        }
      } catch {
        // wmic not available
      }
      return null;
    }

    // Unix
    const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0 ? (result.stdout || "").trim() : null;
  } catch {
    return null;
  }
}

function verifyCodex(pid) {
  if (!isAlive(pid)) return "dead";
  const cmdline = getCmdline(pid);
  if (cmdline === null) return "unknown";
  if (cmdline.includes("codex exec") || cmdline.includes("codex.exe exec") || cmdline.includes("codex.js") && cmdline.includes("exec")) {
    return "verified";
  }
  return "mismatch";
}

function verifyWatchdog(pid) {
  if (!isAlive(pid)) return "dead";
  const cmdline = getCmdline(pid);
  if (cmdline === null) return "unknown";
  if (cmdline.includes("node") && cmdline.includes("_watchdog")) {
    return "verified";
  }
  return "mismatch";
}

function launchWatchdog(timeoutS, targetPid) {
  const script = path.resolve(__filename);
  const nodeExe = process.execPath;
  const args = [script, "_watchdog", String(timeoutS), String(targetPid)];

  const spawnOpts = {
    stdio: "ignore",
    detached: true,
  };
  if (IS_WIN) {
    spawnOpts.windowsHide = true;
  }

  const child = spawn(nodeExe, args, spawnOpts);
  child.unref();
  return child.pid;
}

// ============================================================
// File I/O
// ============================================================

function atomicWrite(filepath, content) {
  const dirpath = path.dirname(filepath);
  const tmpPath = path.join(dirpath, `.${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filepath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function readState(stateDir) {
  const stateFile = path.join(stateDir, "state.json");
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function updateState(stateDir, updates) {
  const state = readState(stateDir);
  Object.assign(state, updates);
  atomicWrite(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));
  return state;
}

// ============================================================
// JSONL parsing
// ============================================================

function parseJsonl(stateDir, lastLineCount, elapsed, processAlive, timeoutVal, state) {
  const jsonlFile = path.join(stateDir, "output.jsonl");
  const errFile = path.join(stateDir, "error.log");

  let allLines = [];
  if (fs.existsSync(jsonlFile)) {
    const content = fs.readFileSync(jsonlFile, "utf8");
    allLines = content.split("\n").filter(l => l.trim());
  }

  let turnCompleted = false;
  let turnFailed = false;
  let turnFailedMsg = "";
  let extractedThreadId = "";
  let reviewText = "";

  // Parse ALL lines for terminal state + data extraction
  for (const rawLine of allLines) {
    const line = rawLine.trim();
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const t = d.type || "";

    if (t === "thread.started" && d.thread_id) {
      extractedThreadId = d.thread_id;
    }

    if (t === "turn.completed") {
      turnCompleted = true;
    } else if (t === "turn.failed") {
      turnFailed = true;
      turnFailedMsg = (d.error && d.error.message) || "unknown error";
    }

    if (t === "item.completed") {
      const item = d.item || {};
      if (item.type === "agent_message") {
        reviewText = item.text || "";
      }
    }
  }

  // Parse NEW lines for progress events
  const stderrLines = [];
  const newLines = allLines.slice(lastLineCount);
  for (const rawLine of newLines) {
    const line = rawLine.trim();
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const t = d.type || "";
    const item = d.item || {};
    const itemType = item.type || "";

    if (t === "turn.started") {
      stderrLines.push(`[${elapsed}s] Codex is thinking...`);
    } else if (t === "item.completed" && itemType === "reasoning") {
      let text = item.text || "";
      if (text.length > 150) text = text.slice(0, 150) + "...";
      stderrLines.push(`[${elapsed}s] Codex thinking: ${text}`);
    } else if (t === "item.started" && itemType === "command_execution") {
      stderrLines.push(`[${elapsed}s] Codex running: ${item.command || ""}`);
    } else if (t === "item.completed" && itemType === "command_execution") {
      stderrLines.push(`[${elapsed}s] Codex completed: ${item.command || ""}`);
    } else if (t === "item.completed" && itemType === "file_change") {
      for (const c of (item.changes || [])) {
        stderrLines.push(`[${elapsed}s] Codex changed: ${c.path || "?"} (${c.kind || "?"})`);
      }
    }
  }

  function sanitizeMsg(s) {
    if (s == null) return "unknown error";
    return String(s).replace(/\s+/g, " ").trim();
  }

  // Determine status
  const stdoutParts = [];
  if (turnCompleted) {
    if (!extractedThreadId || !reviewText) {
      const errorDetail = !extractedThreadId ? "no thread_id" : "no agent_message";
      stdoutParts.push(`POLL:failed:${elapsed}s:1:turn.completed but ${errorDetail}`);
    } else {
      // Write review outputs in requested format(s)
      const format = (state && state.format) || "markdown";
      const metadata = {
        skill: "codex-review",
        effort: (state && state.effort) || "high",
        working_dir: (state && state.working_dir) || "",
        thread_id: extractedThreadId,
        duration_seconds: elapsed
      };
      
      try {
        writeReviewOutputs(stateDir, reviewText, metadata, format);
      } catch (err) {
        // Fallback: always write review.md as primary output
        const reviewPath = path.join(stateDir, "review.md");
        atomicWrite(reviewPath, reviewText);
        process.stderr.write(`Warning: Format conversion failed: ${err.message}\n`);
      }
      
      stdoutParts.push(`POLL:completed:${elapsed}s`);
      stdoutParts.push(`THREAD_ID:${extractedThreadId}`);
    }
  } else if (turnFailed) {
    stdoutParts.push(`POLL:failed:${elapsed}s:3:Codex turn failed: ${sanitizeMsg(turnFailedMsg)}`);
  } else if (!processAlive) {
    if (timeoutVal > 0 && elapsed >= timeoutVal) {
      stdoutParts.push(`POLL:timeout:${elapsed}s:2:Timeout after ${timeoutVal}s`);
    } else {
      let errContent = "";
      if (fs.existsSync(errFile)) {
        errContent = fs.readFileSync(errFile, "utf8").trim();
      }
      let errorMsg = "Codex process exited unexpectedly";
      if (errContent) {
        errorMsg += ": " + sanitizeMsg(errContent.slice(0, 200));
      }
      stdoutParts.push(`POLL:failed:${elapsed}s:1:${errorMsg}`);
    }
  } else {
    stdoutParts.push(`POLL:running:${elapsed}s`);
  }

  return { stdoutOutput: stdoutParts.join("\n"), stderrLines };
}

// ============================================================
// Validation helpers
// ============================================================

function validateStateDir(stateDir) {
  let resolved;
  try {
    resolved = fs.realpathSync(stateDir);
  } catch {
    return { dir: null, err: "Invalid or missing state directory" };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { dir: null, err: "Invalid or missing state directory" };
  }

  const stateFile = path.join(resolved, "state.json");
  if (!fs.existsSync(stateFile)) {
    return { dir: null, err: "state.json not found" };
  }

  // Reconstruct expected path from state.json and compare
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const wd = fs.realpathSync(s.working_dir || "");
    const rid = s.run_id || "";
    const expected = path.join(wd, ".codex-review", "runs", rid);
    const actual = fs.realpathSync(resolved);
    if (expected !== actual) {
      return { dir: null, err: "state directory path mismatch" };
    }
  } catch {
    return { dir: null, err: "state.json validation error" };
  }

  return { dir: resolved, err: null };
}

function verifyAndKillCodex(pid, pgid) {
  if (!pid || pid <= 1 || !pgid || pgid <= 1) return;
  const status = verifyCodex(pid);
  if (status === "verified" || status === "unknown") {
    killTree(pgid);
  }
}

function verifyAndKillWatchdog(pid) {
  if (!pid || pid <= 1) return;
  const status = verifyWatchdog(pid);
  if (status === "verified" || status === "unknown") {
    killSingle(pid);
  }
}

// ============================================================
// Stdin reading
// ============================================================

function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let bytesRead;
  try {
    while (true) {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.slice(0, bytesRead)));
    }
  } catch {
    // EOF or pipe closed
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ============================================================
// Subcommands
// ============================================================

function cmdStart(argv) {
  // Parse arguments
  const { values } = parseArgs({
    args: argv,
    options: {
      "working-dir": { type: "string" },
      effort: { type: "string", default: "high" },
      "thread-id": { type: "string", default: "" },
      timeout: { type: "string", default: "3600" },
      sandbox: { type: "string", default: "read-only" },
    },
    strict: true,
  });

  const workingDir = values["working-dir"];
  const effort = values.effort || "high";
  const threadId = values["thread-id"] || "";
  const timeout = parseInt(values.timeout || "3600", 10);
  const sandbox = values.sandbox || "read-only";

  const VALID_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
  if (!VALID_SANDBOXES.includes(sandbox)) {
    process.stderr.write(`Error: --sandbox must be one of: ${VALID_SANDBOXES.join(", ")}\n`);
    return EXIT_ERROR;
  }

  if (!workingDir) {
    process.stderr.write("Error: --working-dir is required\n");
    return EXIT_ERROR;
  }

  // Check codex in PATH
  const whichCmd = IS_WIN ? "where" : "which";
  const probe = spawnSync(whichCmd, ["codex"], { encoding: "utf8" });
  if (probe.status !== 0) {
    process.stderr.write("Error: codex CLI not found in PATH\n");
    return EXIT_CODEX_NOT_FOUND;
  }

  let resolvedWorkingDir;
  try {
    resolvedWorkingDir = fs.realpathSync(workingDir);
  } catch {
    process.stderr.write(`Error: working directory does not exist: ${workingDir}\n`);
    return EXIT_ERROR;
  }

  // Read prompt from stdin
  const prompt = readStdinSync();
  if (!prompt.trim()) {
    process.stderr.write("Error: no prompt provided on stdin\n");
    return EXIT_ERROR;
  }

  // Create state directory
  const runId = `${Math.floor(Date.now() / 1000)}-${process.pid}`;
  const stateDir = path.join(resolvedWorkingDir, ".codex-review", "runs", runId);
  fs.mkdirSync(stateDir, { recursive: true });

  // Write prompt
  fs.writeFileSync(path.join(stateDir, "prompt.txt"), prompt, "utf8");

  // Track for rollback
  let codexPgid = null;
  let watchdogPid = null;

  function startupCleanup() {
    if (codexPgid !== null) {
      killTree(codexPgid);
    }
    if (watchdogPid !== null && isAlive(watchdogPid)) {
      killSingle(watchdogPid);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  try {
    // Launch Codex
    const { pid: codexPid, pgid } = launchCodex(
      stateDir, resolvedWorkingDir, timeout, threadId, effort, sandbox,
    );
    codexPgid = pgid;

    // Launch watchdog
    watchdogPid = launchWatchdog(timeout, codexPgid);

    // Write state.json atomically
    const now = Math.floor(Date.now() / 1000);
    const state = {
      pid: codexPid,
      pgid: codexPgid,
      watchdog_pid: watchdogPid,
      run_id: runId,
      state_dir: stateDir,
      working_dir: resolvedWorkingDir,
      effort,
      sandbox,
      timeout,
      format,
      started_at: now,
      thread_id: threadId,
      last_line_count: 0,
      stall_count: 0,
      last_poll_at: 0,
    };
    atomicWrite(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    startupCleanup();
    return EXIT_ERROR;
  }

  // Success
  process.stdout.write(`CODEX_STARTED:${stateDir}\n`);
  return EXIT_SUCCESS;
}

function cmdPoll(argv) {
  const stateDirArg = argv[0];
  if (!stateDirArg) {
    process.stdout.write("POLL:failed:0s:1:Invalid or missing state directory\n");
    return EXIT_ERROR;
  }

  const { dir: stateDir, err } = validateStateDir(stateDirArg);
  if (err) {
    process.stdout.write(`POLL:failed:0s:1:${err}\n`);
    return EXIT_ERROR;
  }

  // Check for cached final result
  const finalFile = path.join(stateDir, "final.txt");
  if (fs.existsSync(finalFile)) {
    const cached = fs.readFileSync(finalFile, "utf8");
    process.stdout.write(cached);
    if (!cached.endsWith("\n")) process.stdout.write("\n");
    const reviewFile = path.join(stateDir, "review.md");
    const legacyReviewFile = path.join(stateDir, "review.txt");
    if (fs.existsSync(reviewFile)) {
      process.stderr.write(`[cached] Review available in ${stateDir}/review.md\n`);
    } else if (fs.existsSync(legacyReviewFile)) {
      // Migrate legacy v9 review.txt → review.md for automation compatibility
      try {
        const legacyContent = fs.readFileSync(legacyReviewFile, "utf8");
        atomicWrite(reviewFile, legacyContent);
        process.stderr.write(`[cached] Migrated legacy review.txt → review.md in ${stateDir}\n`);
      } catch {
        process.stderr.write(`[cached] Review available in ${stateDir}/review.txt (legacy v9 state)\n`);
      }
    }
    return EXIT_SUCCESS;
  }

  // Read state
  const state = readState(stateDir);
  const codexPid = state.pid || 0;
  const codexPgid = state.pgid || 0;
  const watchdogPid = state.watchdog_pid || 0;
  const timeoutVal = state.timeout || 3600;
  const startedAt = state.started_at || Math.floor(Date.now() / 1000);
  const lastLineCount = state.last_line_count || 0;
  const stallCount = state.stall_count || 0;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - startedAt;

  // Check if process is alive
  const processAlive = isAlive(codexPid);

  // Count lines
  const jsonlFile = path.join(stateDir, "output.jsonl");
  let currentLineCount = 0;
  if (fs.existsSync(jsonlFile)) {
    const content = fs.readFileSync(jsonlFile, "utf8");
    currentLineCount = content.split("\n").filter((l) => l.trim()).length;
  }

  // Stall detection
  const newStallCount = currentLineCount === lastLineCount
    ? stallCount + 1
    : 0;

  // Parse JSONL
  let { stdoutOutput: pollOutput, stderrLines } = parseJsonl(
    stateDir, lastLineCount, elapsed, processAlive, timeoutVal, state
  );

  // Print progress to stderr
  for (const line of stderrLines) {
    process.stderr.write(line + "\n");
  }

  // Determine poll status from first line
  const firstLine = pollOutput.split("\n")[0] || "";
  const parts = firstLine.split(":");
  let pollStatus = parts.length >= 2 ? parts[1] : "";

  function writeFinalAndCleanup(content) {
    atomicWrite(path.join(stateDir, "final.txt"), content);
    verifyAndKillCodex(codexPid, codexPgid);
    if (watchdogPid) {
      verifyAndKillWatchdog(watchdogPid);
    }
  }

  if (pollStatus !== "running") {
    writeFinalAndCleanup(pollOutput);
  } else {
    // Check timeout/stall only when still running
    if (elapsed >= timeoutVal) {
      pollOutput = `POLL:timeout:${elapsed}s:${EXIT_TIMEOUT}:Timeout after ${timeoutVal}s`;
      writeFinalAndCleanup(pollOutput);
    } else if (newStallCount >= 12 && processAlive) {
      pollOutput = `POLL:stalled:${elapsed}s:${EXIT_STALLED}:No new output for ~3 minutes`;
      writeFinalAndCleanup(pollOutput);
    }
  }

  // Update state.json
  updateState(stateDir, {
    last_line_count: currentLineCount,
    stall_count: newStallCount,
    last_poll_at: now,
  });

  process.stdout.write(pollOutput + "\n");
  return EXIT_SUCCESS;
}

function cmdStop(argv) {
  const stateDirArg = argv[0];
  if (!stateDirArg) {
    process.stderr.write("Error: state directory argument required\n");
    return EXIT_ERROR;
  }

  const { dir: stateDir, err } = validateStateDir(stateDirArg);
  if (err) {
    process.stderr.write(`Error: ${err}\n`);
    return EXIT_ERROR;
  }

  // Read state and kill processes
  try {
    const state = readState(stateDir);
    const codexPid = state.pid || 0;
    const codexPgid = state.pgid || 0;
    const watchdogPid = state.watchdog_pid || 0;

    if (codexPid && codexPgid) {
      verifyAndKillCodex(codexPid, codexPgid);
    }
    if (watchdogPid) {
      verifyAndKillWatchdog(watchdogPid);
    }
  } catch {
    // State may be corrupted, proceed to cleanup
  }

  // Remove state directory
  fs.rmSync(stateDir, { recursive: true, force: true });
  return EXIT_SUCCESS;
}

function cmdWatchdog(argv) {
  const timeoutS = parseInt(argv[0], 10);
  const targetPid = parseInt(argv[1], 10);

  if (isNaN(timeoutS) || isNaN(targetPid)) {
    process.stderr.write("Error: _watchdog requires <timeout> <pid>\n");
    return EXIT_ERROR;
  }

  // Detach from parent session on Unix
  if (!IS_WIN) {
    try {
      process.setsid && process.setsid();
    } catch {
      // setsid may not be available in all Node.js builds
    }
  }

  // Use setTimeout to wait, then kill target
  setTimeout(() => {
    killTree(targetPid);
    process.exit(EXIT_SUCCESS);
  }, timeoutS * 1000);

  // Keep the process alive
  return -1; // Signal: don't exit immediately
}

// ============================================================
// Detection Engine
// ============================================================

function gitAvailable() {
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0) return true;
    // Fallback: try gitExec-style with shell on Windows
    if (IS_WIN) {
      const r2 = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000, shell: true });
      if (r2.status === 0) return true;
    }
    process.stderr.write(`git detection failed: status=${r.status} error=${r.error || "none"} stderr=${(r.stderr || "").trim()}\n`);
    return false;
  } catch (e) {
    process.stderr.write(`git detection exception: ${e.message}\n`);
    return false;
  }
}

function gitExec(args, cwd) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd, timeout: 15000 });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim();
}

function resolveBaseBranch(cwd, explicit) {
  if (explicit) return explicit;
  for (const branch of ["main", "master"]) {
    const r = spawnSync("git", ["rev-parse", "--verify", branch], {
      encoding: "utf8", cwd, timeout: 5000,
    });
    if (r.status === 0) return branch;
  }
  return null;
}

function collectSourceFiles(dir, maxFiles) {
  const results = [];
  function walk(current, relPath) {
    if (results.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          walk(path.join(current, entry.name), childRel);
        }
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(childRel);
      }
    }
  }
  walk(dir, "");
  return results;
}

/** Collect files matching security extensions or config file names (bounded walk). */
function collectSecurityFiles(dir, maxFiles) {
  const results = [];
  function walk(current, relPath) {
    if (results.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          walk(path.join(current, entry.name), childRel);
        }
      } else if (
        SECURITY_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ||
        SECURITY_CONFIG_FILES.has(entry.name)
      ) {
        results.push(childRel);
      }
    }
  }
  walk(dir, "");
  return results;
}

function cmdDetect(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "working-dir": { type: "string" },
      scope: { type: "string", default: "working-tree" },
      threshold: { type: "string", default: "50" },
      "base-branch": { type: "string", default: "" },
      "max-files": { type: "string", default: "500" },
    },
    strict: true,
  });

  const workingDir = values["working-dir"];
  const scope = values.scope;
  const threshold = parseInt(values.threshold, 10);
  const baseBranchFlag = values["base-branch"] || "";
  const maxFiles = parseInt(values["max-files"], 10);

  if (!workingDir) {
    process.stderr.write("Error: --working-dir is required\n");
    return EXIT_ERROR;
  }

  const validScopes = ["working-tree", "branch", "full"];
  if (!validScopes.includes(scope)) {
    process.stderr.write(`Error: invalid scope '${scope}'. Valid: ${validScopes.join(", ")}\n`);
    return EXIT_ERROR;
  }

  let resolvedDir;
  try {
    resolvedDir = fs.realpathSync(workingDir);
  } catch {
    process.stderr.write(`Error: working directory does not exist: ${workingDir}\n`);
    return EXIT_ERROR;
  }

  try {
    const entries = fs.readdirSync(resolvedDir);
    if (entries.length === 0) {
      process.stderr.write("Error: working directory is empty\n");
      return EXIT_ERROR;
    }
  } catch {
    process.stderr.write(`Error: cannot read working directory: ${workingDir}\n`);
    return EXIT_ERROR;
  }

  const hasGit = gitAvailable();
  let exitCode = EXIT_SUCCESS;

  const scores = {
    "codex-impl-review": { score: 0, confidence: "low", reasons: [], signals: [] },
    "codex-security-review": { score: 0, confidence: "low", reasons: [], signals: [] },
    "codex-plan-review": { score: 0, confidence: "low", reasons: [], signals: [] },
    "codex-commit-review": { score: 0, confidence: "low", reasons: [], signals: [] },
    "codex-pr-review": { score: 0, confidence: "low", reasons: [], signals: [] },
    "codex-codebase-review": { score: 0, confidence: "low", reasons: [], signals: [] },
  };

  function addScore(skill, points, reason, signalType = "unknown", matched = null) {
    const s = scores[skill];
    s.score = Math.min(100, s.score + points);
    s.reasons.push(reason);
    
    // Track signal for explainability
    s.signals.push({
      type: signalType,
      weight: points,
      reason: reason,
      matched: matched
    });
  }
  
  function calculateConfidence(skill) {
    const s = scores[skill];
    if (s.score === 0) return "low"; // Map zero score to low instead of "none"
    
    // Count unique (type, reason) pairs for better diversity measurement
    const signalIdentities = new Set(s.signals.map(sig => `${sig.type}:${sig.reason}`));
    const signalDiversity = signalIdentities.size;
    
    // Confidence based on score + signal diversity
    if (s.score >= 80 && signalDiversity >= 3) return "high";
    if (s.score >= 50 && signalDiversity >= 2) return "medium";
    if (s.score >= 80) return "medium";
    return "low"; // Map all low scores to "low" instead of "very-low"
  }

  // --- Scope-based rules (require git) ---
  if (hasGit) {
    if (scope === "working-tree") {
      // Working-tree: score based on uncommitted changes only
      const unstaged = gitExec(["diff", "--name-only"], resolvedDir);
      const staged = gitExec(["diff", "--cached", "--name-only"], resolvedDir);
      if (unstaged && unstaged.length > 0) {
        addScore("codex-impl-review", 100, "has uncommitted code changes", "git_state", "uncommitted changes");
      }
      if (staged && staged.length > 0) {
        addScore("codex-commit-review", 100, "has staged files ready for commit", "git_state", "staged files");
      }

      const currentBranch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], resolvedDir);
      if (currentBranch && currentBranch !== "main" && currentBranch !== "master" && currentBranch !== "HEAD") {
        const upstream = gitExec(["rev-parse", "--abbrev-ref", "@{upstream}"], resolvedDir);
        if (upstream) {
          addScore("codex-pr-review", 80, `on branch '${currentBranch}' with upstream`, "git_state", currentBranch);
        }
      }
    }

    if (scope === "branch") {
      // Branch: score based on branch diff only, NOT working-tree state
      const baseBranch = resolveBaseBranch(resolvedDir, baseBranchFlag);
      if (!baseBranch) {
        process.stderr.write("Error: cannot determine base branch for branch scope — use --base-branch\n");
        return EXIT_ERROR;
      }
      const branchDiff = gitExec(["diff", "--name-only", `${baseBranch}...HEAD`], resolvedDir);
      if (branchDiff && branchDiff.length > 0) {
        addScore("codex-impl-review", 100, `branch has changes vs ${baseBranch}`, "git_state", `diff vs ${baseBranch}`);
      }
      const currentBranch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], resolvedDir);
      if (currentBranch && currentBranch !== "main" && currentBranch !== "master" && currentBranch !== "HEAD") {
        const upstream = gitExec(["rev-parse", "--abbrev-ref", "@{upstream}"], resolvedDir);
        if (upstream) {
          addScore("codex-pr-review", 80, `on branch '${currentBranch}' with upstream`, "git_state", currentBranch);
        }
      }
    }
  } else {
    exitCode = EXIT_GIT_NOT_FOUND;
    process.stderr.write("Warning: git not available — detection limited to file patterns\n");
  }

  // --- File-based detection ---
  let filesToScan = [];
  let allChangedFiles = []; // unfiltered by extension, for security checks

  if (scope === "full" || !hasGit) {
    filesToScan = collectSourceFiles(resolvedDir, maxFiles);
    // For full scope, also collect security-relevant files (not just source)
    const secFiles = collectSecurityFiles(resolvedDir, 200);
    allChangedFiles = [...new Set([...filesToScan, ...secFiles])];
  } else if (scope === "working-tree") {
    if (hasGit) {
      const unstaged = gitExec(["diff", "--name-only"], resolvedDir) || "";
      const staged = gitExec(["diff", "--cached", "--name-only"], resolvedDir) || "";
      const allChanged = new Set([
        ...unstaged.split("\n").filter(Boolean),
        ...staged.split("\n").filter(Boolean),
      ]);
      allChangedFiles = [...allChanged].sort();
      filesToScan = allChangedFiles.filter(f =>
        SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase())
      ).slice(0, maxFiles);
    }
  } else if (scope === "branch") {
    if (hasGit) {
      const baseBranch = resolveBaseBranch(resolvedDir, baseBranchFlag);
      if (baseBranch) {
        const branchFiles = gitExec(["diff", "--name-only", `${baseBranch}...HEAD`], resolvedDir) || "";
        allChangedFiles = branchFiles.split("\n").filter(Boolean).sort();
        filesToScan = allChangedFiles.filter(f =>
          SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase())
        ).slice(0, maxFiles);
      }
    }
  }

  // Full scope: check file count for codebase-review
  if (scope === "full") {
    const allSourceFiles = collectSourceFiles(resolvedDir, maxFiles + 1);
    if (allSourceFiles.length > 50) {
      addScore("codex-codebase-review", 100, `${allSourceFiles.length} source files (recommend /codex-codebase-review directly)`, "scope", `${allSourceFiles.length} files`);
    } else {
      addScore("codex-impl-review", 80, `${allSourceFiles.length} source files (small project, full scope)`, "scope", `${allSourceFiles.length} files`);
    }
  }

  // Plan file detection
  let planFound = false;
  for (const pf of PLAN_FILE_PATTERNS) {
    if (fs.existsSync(path.join(resolvedDir, pf))) {
      addScore("codex-plan-review", 100, `${pf} exists`, "file_pattern", pf);
      planFound = true;
      break;
    }
  }
  if (!planFound) {
    try {
      const rootFiles = fs.readdirSync(resolvedDir);
      for (const f of rootFiles) {
        if (f.endsWith(PLAN_SUFFIX)) {
          addScore("codex-plan-review", 100, `${f} exists`, "file_pattern", f);
          planFound = true;
          break;
        }
      }
    } catch { /* ignore */ }
  }
  if (!planFound) {
    try {
      const docsDir = path.join(resolvedDir, "docs");
      if (fs.existsSync(docsDir)) {
        function findPlanFiles(dir, rel) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              findPlanFiles(path.join(dir, e.name), childRel);
            } else if (PLAN_GLOB_PATTERN.test(`docs/${childRel}`)) {
              addScore("codex-plan-review", 100, `docs/${childRel} matches plan pattern`, "file_pattern", `docs/${childRel}`);
              planFound = true;
              return;
            }
            if (planFound) return;
          }
        }
        findPlanFiles(docsDir, "");
      }
    } catch { /* ignore */ }
  }

  // .env file check
  if (fs.existsSync(path.join(resolvedDir, ".env"))) {
    addScore("codex-security-review", 15, ".env file present", "file_pattern", ".env");
  }

  // Security file extensions and config files (check changed files + root)
  // For working-tree/branch, check the changed files list for security extensions
  // For full scope, the recursive walk already covers these
  let secExtFound = false;
  let secConfigFound = false;

  // Check changed files for security-relevant extensions
  for (const relFile of allChangedFiles) {
    if (!secExtFound && SECURITY_FILE_EXTENSIONS.has(path.extname(relFile).toLowerCase())) {
      addScore("codex-security-review", 20, `security-related file extension: ${path.extname(relFile)}`, "file_pattern", path.extname(relFile));
      secExtFound = true;
    }
    if (!secConfigFound && SECURITY_CONFIG_FILES.has(path.basename(relFile))) {
      addScore("codex-security-review", 15, `config file: ${path.basename(relFile)}`, "file_pattern", path.basename(relFile));
      secConfigFound = true;
    }
    if (secExtFound && secConfigFound) break;
  }

  // Also check root directory for config files not in changed set
  try {
    const rootFiles = fs.readdirSync(resolvedDir);
    for (const f of rootFiles) {
      if (!secExtFound && SECURITY_FILE_EXTENSIONS.has(path.extname(f).toLowerCase())) {
        addScore("codex-security-review", 20, `security-related file extension: ${path.extname(f)}`, "file_pattern", path.extname(f));
        secExtFound = true;
      }
      if (!secConfigFound && SECURITY_CONFIG_FILES.has(f)) {
        addScore("codex-security-review", 15, `config file: ${f}`, "file_pattern", f);
        secConfigFound = true;
      }
      if (secExtFound && secConfigFound) break;
    }
  } catch { /* ignore */ }

  // Content-based security scanning
  const MAX_FILE_SIZE = 100 * 1024; // 100KB
  const securityHits = new Map(); // Key by unique pattern identifier (regex source)
  
  for (const relFile of filesToScan) {
    const absFile = path.join(resolvedDir, relFile);
    let content;
    try {
      const stat = fs.statSync(absFile);
      if (stat.size > MAX_FILE_SIZE) continue;
      content = fs.readFileSync(absFile, "utf8");
    } catch { continue; }

    for (const pattern of SECURITY_PATTERNS) {
      if (pattern.regex.test(content)) {
        // Use regex source as unique key to prevent merging distinct patterns
        const uniqueKey = pattern.regex.source;
        if (!securityHits.has(uniqueKey)) {
          securityHits.set(uniqueKey, { count: 0, files: new Set(), pattern });
        }
        const hit = securityHits.get(uniqueKey);
        hit.count++;
        hit.files.add(relFile);
      }
    }
  }
  
  // Add scores for each unique pattern hit
  for (const [uniqueKey, hit] of securityHits.entries()) {
    const count = hit.count;
    const fileList = Array.from(hit.files).slice(0, 3).join(", ");
    const matched = hit.files.size > 3 ? `${fileList} (+${hit.files.size - 3} more)` : fileList;
    addScore("codex-security-review", hit.pattern.score, `${hit.pattern.reason} in ${count} file${count > 1 ? "s" : ""}`, "content_pattern", matched);
  }

  // Non-delegatable skills — filter out of runnable list, expose as recommendations
  const NON_DELEGATABLE = new Set(["codex-codebase-review"]);

  // Calculate confidence for all skills
  for (const skill of Object.keys(scores)) {
    scores[skill].confidence = calculateConfidence(skill);
  }

  // Build output
  const selectedSkills = Object.entries(scores)
    .filter(([, v]) => v.score >= threshold)
    .sort((a, b) => b[1].score - a[1].score)
    .map(([k]) => k);

  const runnableSkills = selectedSkills.filter(s => !NON_DELEGATABLE.has(s));
  const recommendations = selectedSkills.filter(s => NON_DELEGATABLE.has(s));

  const output = {
    skills: runnableSkills,
    recommendations,
    scores,
    scope,
    files_analyzed: filesToScan.length,
    files_capped: filesToScan.length >= maxFiles,
    threshold,
    git_available: hasGit,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  return exitCode;
}

// ============================================================
// CLI
// ============================================================

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || "";
  const rest = argv.slice(1);

  let exitCode;

  switch (command) {
    case "version":
      process.stdout.write(`${CODEX_RUNNER_VERSION}\n`);
      exitCode = EXIT_SUCCESS;
      break;
    case "start":
      exitCode = cmdStart(rest);
      break;
    case "poll":
      exitCode = cmdPoll(rest);
      break;
    case "stop":
      exitCode = cmdStop(rest);
      break;
    case "_watchdog":
      exitCode = cmdWatchdog(rest);
      break;
    case "detect":
      exitCode = cmdDetect(rest);
      break;
    default:
      process.stderr.write(
        "codex-runner.js — Cross-platform toolkit for Codex CLI review skills\n\n" +
        "Usage:\n" +
        "  node codex-runner.js version\n" +
        "  node codex-runner.js start --working-dir <dir> [--effort <level>] [--thread-id <id>] [--timeout <s>] [--sandbox <mode>]\n" +
        "  node codex-runner.js poll <state_dir>\n" +
        "  node codex-runner.js stop <state_dir>\n" +
        "  node codex-runner.js detect --working-dir <dir> [--scope <working-tree|branch|full>] [--threshold <0-100>] [--base-branch <branch>] [--max-files <N>]\n",
      );
      exitCode = command ? EXIT_ERROR : EXIT_SUCCESS;
      break;
  }

  // _watchdog returns -1 to keep process alive
  if (exitCode >= 0) {
    process.exit(exitCode);
  }
}

main();
