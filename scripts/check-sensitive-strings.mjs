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
 *    node scripts/check-sensitive-strings.mjs           # Report, exit 0
 *    node scripts/check-sensitive-strings.mjs --check   # CI: exit 1 on hits
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, extname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.slice(2).includes('--check')

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
  // vendor forks and external extensions have their own upstream sources
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
const SCAN_NAMES = new Set(['.env.example', 'Dockerfile'])

const SKIP_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'settings.local.json', // local gitignored config
  'sensitive-rules.json', // external rules config (contains patterns, not scanned)
])

/**
 * Default rules used when no external config exists. Empty by design: the real
 * rules live in the gitignored scripts/sensitive-rules.json so that this file
 * carries no sensitive patterns. Without the config there is nothing to scan
 * for — flagging the RFC placeholder values themselves would be a false hit.
 */
const DEFAULT_RULES = []

/**
 * Load rules from external JSON config if present, otherwise use defaults.
 * The external config path is: scripts/sensitive-rules.json
 */
function loadRules() {
  const configPath = join(REPO_ROOT, 'scripts', 'sensitive-rules.json')
  if (!existsSync(configPath)) {
    return DEFAULT_RULES
  }
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed.map((r) => ({
      id: r.id,
      desc: r.desc,
      re: new RegExp(r.pattern, r.flags || 'gi'),
      allow: r.allow ? r.allow.map((a) => new RegExp(a.pattern, a.flags || '')) : undefined,
      allowMatch: r.allowMatch
        ? r.allowMatch.map((a) => new RegExp(a.pattern, a.flags || ''))
        : undefined,
    }))
  } catch (err) {
    console.error(`[sensitive-strings] Failed to load rules from ${configPath}:`, err.message)
    return DEFAULT_RULES
  }
}

function collectFiles(dir, files = []) {
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

function scan(file, rules) {
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

function main() {
  const rules = loadRules()
  const files = collectFiles(REPO_ROOT)
  const findings = []

  for (const file of files) {
    for (const hit of scan(file, rules)) {
      findings.push({ file: relative(REPO_ROOT, file).replace(/\\/g, '/'), ...hit })
    }
  }

  if (findings.length === 0) {
    console.log(`[sensitive-strings] ${files.length} files, no unwanted patterns found ✓`)
    return
  }

  console.error(`[sensitive-strings] Found ${findings.length} unwanted pattern(s):`)
  const byRule = new Map()
  for (const f of findings) {
    if (!byRule.has(f.rule.id)) byRule.set(f.rule.id, [])
    byRule.get(f.rule.id).push(f)
  }
  for (const [id, items] of byRule) {
    console.error(`\n  ${id} — ${items[0].rule.desc}`)
    for (const it of items) {
      console.error(`    ${it.file}:${it.line}  ${it.match}`)
    }
  }
  console.error(
    '\n  Placeholder conventions: domains *.example.com (RFC 2606); IPs 192.0.2.x (RFC 5737); ' +
      'codenames acme / depot / tracker; local paths X:/workspace; accounts testuser / dev. ' +
      '\n  To exempt a line as harmless coincidence, add a `sensitive-strings:allow` comment.',
  )
  if (CHECK_ONLY) process.exit(1)
}

main()
