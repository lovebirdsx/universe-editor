/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  check-sensitive-strings.mjs — Scan for unwanted patterns in the repository.
 *
 *  This script scans source files and documentation for patterns that should
 *  not appear in the public repository. Rules are loaded from an external
 *  JSON configuration file to keep the scanner itself free of sensitive data.
 *
 *  Usage:
 *    node scripts/check-sensitive-strings.mjs                 # Report, exit 0
 *    node scripts/check-sensitive-strings.mjs --check         # CI: exit 1 on hits / missing rules
 *    node scripts/check-sensitive-strings.mjs --check --mask  # CI: mask hit text in output
 *
 *  Env:
 *    SENSITIVE_STRINGS_ALLOW_MISSING=1  # downgrade a missing rules file to a warning (exit 0)
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, extname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RULES_PATH = join(REPO_ROOT, 'scripts', 'sensitive-rules.json')

/** Directories to skip: build outputs, dependencies, vendor forks, gitignored local files. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'dist-bundle',
  'out',
  'out-dev',
  'release',
  'coverage',
  'market-stage',
  'playwright-report',
  'test-results',
  '.next',
  // vendor / extensions-external are git submodules: the main repo records only
  // gitlinks, cleanup must happen inside each fork — intentionally out of scope here
  'vendor',
  'extensions-external',
  // gitignored local artifacts: not in public repo
  'plans',
  'explore-results',
  'handoff',
])

/** Only scan text source and documentation; skip binaries and lock files. */
const SCAN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.ps1',
  '.html',
  '.css',
  '.example',
])

/** Files without extension that should be scanned. */
const SCAN_NAMES = new Set(['.env.example', 'Dockerfile', '.gitmodules', '.npmrc'])

const SKIP_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'settings.local.json', // local gitignored config
  'sensitive-rules.json', // external rules config (contains patterns, not scanned)
  'sensitive-rules.example.json', // skeleton; its sentinel patterns must not self-flag
])

// allow/allowMatch are used with .test() across every line of every file, so a `g`
// flag would advance lastIndex and make the same pattern alternate true/false —
// silently letting a real leak through. Strip `g` from them; force it on the main
// pattern instead, which matchAll requires.
function withGlobal(flags) {
  return flags.includes('g') ? flags : `${flags}g`
}

function withoutGlobal(flags) {
  return flags.replace(/g/g, '')
}

export function compileRule(r) {
  return {
    id: r.id,
    desc: r.desc,
    re: new RegExp(r.pattern, withGlobal(r.flags || 'gi')),
    allow: r.allow
      ? r.allow.map((a) => new RegExp(a.pattern, withoutGlobal(a.flags || '')))
      : undefined,
    allowMatch: r.allowMatch
      ? r.allowMatch.map((a) => new RegExp(a.pattern, withoutGlobal(a.flags || '')))
      : undefined,
  }
}

// JSON.parse / new RegExp embed rule-file content in err.message, and the rules
// themselves are sensitive — never surface err.message, return a fixed string.
export function safeLoadError(_err) {
  return 'invalid JSON or rule (inspect the file locally for details)'
}

export function loadRules(configPath = DEFAULT_RULES_PATH) {
  if (!existsSync(configPath)) {
    return { status: 'missing', rules: [], configPath }
  }
  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return { status: 'parse-error', rules: [], configPath, error: safeLoadError() }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { status: 'parse-error', rules: [], configPath, error: safeLoadError(err) }
  }
  if (!Array.isArray(parsed)) {
    return { status: 'parse-error', rules: [], configPath, error: safeLoadError() }
  }
  try {
    const rules = parsed.map(compileRule)
    if (rules.length === 0) {
      return { status: 'empty', rules: [], configPath }
    }
    return { status: 'ok', rules, configPath }
  } catch (err) {
    return { status: 'parse-error', rules: [], configPath, error: safeLoadError(err) }
  }
}

export function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(join(dir, entry.name), files)
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILES.has(entry.name)) continue
    if (SCAN_NAMES.has(entry.name) || SCAN_EXTS.has(extname(entry.name))) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

export function scanFile(file, rules) {
  const hits = []
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return hits
  }
  // Skip extremely long lines (likely inline base64 / minified resources)
  const lines = source.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (line.length > 2000) return
    if (line.includes('sensitive-strings:allow')) return
    for (const rule of rules) {
      if (rule.allow?.some((a) => a.test(line))) continue
      rule.re.lastIndex = 0
      for (const m of line.matchAll(rule.re)) {
        // allowMatch only checks the matched fragment, avoiding unrelated content
        // on the same line from exempting a real leak
        if (rule.allowMatch?.some((a) => a.test(m[0]))) continue
        hits.push({ line: i + 1, rule, match: m[0] })
      }
    }
  })
  return hits
}

// The values this scanner guards are low-entropy (internal domains, codenames,
// account names), so `len` would hand an attacker the candidate space and make the
// digest dictionary-invertible. Print the full digest and nothing about the shape:
// it still correlates the same literal across hits, which is all CI triage needs.
export function maskMatch(match) {
  return `sha=${createHash('sha256').update(match).digest('hex')}`
}

export function formatHit(relFile, hit, mask) {
  return `${relFile}:${hit.line}  ${mask ? maskMatch(hit.match) : hit.match}`
}

export function formatGroupHeader(id, items, mask) {
  // desc can embed literal internal domains/codenames; mask mode prints id + count only
  if (mask) return `${id} — ${items.length} hit(s)`
  return `${id} — ${items[0].rule.desc}`
}

export function groupFindings(findings) {
  const byRule = new Map()
  for (const f of findings) {
    if (!byRule.has(f.rule.id)) byRule.set(f.rule.id, [])
    byRule.get(f.rule.id).push(f)
  }
  return byRule
}

export function checkSensitiveStrings({
  repoRoot = REPO_ROOT,
  configPath = DEFAULT_RULES_PATH,
  check = false,
  allowMissing = false,
} = {}) {
  const loaded = loadRules(configPath)

  if (loaded.status === 'missing' && check && allowMissing) {
    return { exit: 0, status: 'missing-allowed', findings: [], fileCount: 0, ruleCount: 0 }
  }

  if (loaded.status === 'ok') {
    const files = collectFiles(repoRoot)
    const findings = []
    for (const file of files) {
      for (const hit of scanFile(file, loaded.rules)) {
        findings.push({ file: relative(repoRoot, file).replace(/\\/g, '/'), ...hit })
      }
    }
    const exit = check && findings.length > 0 ? 1 : 0
    return { exit, status: 'ok', findings, fileCount: files.length, ruleCount: loaded.rules.length }
  }

  return {
    exit: check ? 1 : 0,
    status: loaded.status,
    findings: [],
    fileCount: 0,
    ruleCount: 0,
    ...(loaded.error ? { error: loaded.error } : {}),
  }
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const mask = args.includes('--mask')
  const allowMissing = process.env.SENSITIVE_STRINGS_ALLOW_MISSING === '1'

  const result = checkSensitiveStrings({ check, allowMissing })

  if (result.status === 'ok' && result.findings.length === 0) {
    console.log(
      `[sensitive-strings] ${result.fileCount} files, ${result.ruleCount} rule(s), no unwanted patterns found ✓`,
    )
    process.exit(0)
  }

  if (result.status === 'ok') {
    console.error(`[sensitive-strings] Found ${result.findings.length} unwanted pattern(s):`)
    for (const [id, items] of groupFindings(result.findings)) {
      console.error(`\n  ${formatGroupHeader(id, items, mask)}`)
      for (const it of items) {
        console.error(`    ${formatHit(it.file, it, mask)}`)
      }
    }
    if (mask) {
      console.error(
        '\n  命中原文已掩码。本地跑 `pnpm sensitive:check`（不加 --mask）查看完整命中。',
      )
    } else {
      console.error(
        '\n  Placeholder conventions: domains *.example.com (RFC 2606); IPs 192.0.2.x (RFC 5737); ' +
          'codenames acme / depot / tracker; local paths X:/workspace; accounts testuser / dev. ' +
          '\n  To exempt a line as harmless coincidence, add a `sensitive-strings:allow` comment.',
      )
    }
    process.exit(result.exit)
  }

  // Repo-relative, never absolute: this output gets pasted into issues and CI logs,
  // and an absolute path leaks the developer's checkout layout / runner paths.
  const rulesPath = relative(REPO_ROOT, DEFAULT_RULES_PATH).replace(/\\/g, '/')

  if (result.status === 'missing') {
    console.error(`[sensitive-strings] Sensitive rules file missing: ${rulesPath}`)
    console.error(
      '  Inject SENSITIVE_RULES via CI secret, or create it locally from scripts/sensitive-rules.example.json.',
    )
  } else if (result.status === 'missing-allowed') {
    console.error(
      `[sensitive-strings] Sensitive rules file missing, guard skipped (SENSITIVE_STRINGS_ALLOW_MISSING=1): ${rulesPath}`,
    )
  } else if (result.status === 'empty') {
    console.error(`[sensitive-strings] Sensitive rules file has 0 rules: ${rulesPath}`)
  } else if (result.status === 'parse-error') {
    console.error(`[sensitive-strings] Failed to load rules: ${rulesPath}: ${result.error}`)
  }

  process.exit(result.exit)
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  main()
}
