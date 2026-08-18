#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Normalizes future-dated file mtimes before any tsgo-driven task runs.
 *
 *  WSL2's VM clock can boot from a wrong RTC (observed +24h on this machine) until NTP
 *  corrects it; files written inside that window carry mtimes in the future. `tsgo --build`
 *  decides project freshness by mtime ORDER (input older than tsbuildinfo → up to date →
 *  skip), so once a tsbuildinfo or dist artifact is future-dated, typecheck silently replays
 *  stale results for up to a day: phantom errors against old declarations, or missed real
 *  ones. Everything else in the toolchain (turbo, eslint --cache-strategy content, vitest)
 *  hashes content and is immune.
 *
 *  Repair is direction-aware:
 *   - a future-dated *tsbuildinfo* is deleted — touching it to `now` would keep it newer
 *     than every real input and the bogus up-to-date verdict would survive;
 *   - any other future-dated file is touched to `now` — "newer" can only trigger an extra
 *     re-check, never suppress one.
 *
 *  The CLI only acts on WSL (see isWsl); healthy trees find nothing and stay silent.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, rmSync, statSync, utimesSync, realpathSync } from 'node:fs'
import path, { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const SCAN_ROOTS = ['apps', 'packages', 'extensions', 'extensions-external']

// tsgo's mtime comparisons only involve sources, emitted dist and *tsbuildinfo*; the rest
// is dependencies/caches or generated bulk tsgo never stats.
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'out',
  'out-dev',
  'release',
  'resources',
  'build',
  'public',
  'test-results',
  'playwright-report',
  '.runtime-resources',
])

// Filters filesystem mtime coarseness and harmless small skews; only RTC-scale offsets count.
export const TOLERANCE_MS = 2 * 60 * 1000

export function normalizeFutureMtimes(
  rootDir,
  { now = new Date(), toleranceMs = TOLERANCE_MS, skipDirs = SKIP_DIRS } = {},
) {
  const cutoff = now.getTime() + toleranceMs
  const removed = []
  const touched = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      let stats
      try {
        stats = statSync(abs)
      } catch {
        continue
      }
      if (stats.mtimeMs <= cutoff) continue
      try {
        if (entry.name.includes('tsbuildinfo')) {
          rmSync(abs, { force: true })
          removed.push(abs)
        } else {
          utimesSync(abs, now, now)
          touched.push(abs)
        }
      } catch {
        // best-effort: an unrepairable entry must not fail the whole check run
      }
    }
  }
  walk(rootDir)
  return { removed, touched }
}

// The clock pathology is WSL-specific; elsewhere the scan is dead weight, and on a machine
// whose clock is genuinely behind it could misjudge healthy files as future-dated.
export function isWsl() {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

function main() {
  if (!isWsl()) return
  const now = new Date()
  const removed = []
  const touched = []
  for (const root of SCAN_ROOTS) {
    const result = normalizeFutureMtimes(resolve(repoRoot, root), { now })
    removed.push(...result.removed)
    touched.push(...result.touched)
  }
  if (removed.length === 0 && touched.length === 0) return
  console.log(
    `[ensure-fresh-mtimes] future-dated files detected (clock skew?) — removed ${removed.length} tsbuildinfo, normalized ${touched.length} mtime(s):`,
  )
  for (const abs of [...removed, ...touched].slice(0, 10)) {
    console.log(`  - ${relative(repoRoot, abs)}`)
  }
  const rest = removed.length + touched.length - 10
  if (rest > 0) console.log(`  ... and ${rest} more`)
}

const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]).split(path.sep).join('/') ===
    fileURLToPath(import.meta.url).split(path.sep).join('/')
if (invokedDirectly) {
  main()
}
