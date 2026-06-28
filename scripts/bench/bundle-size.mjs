#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Renderer bundle-size observability.
 *
 *  Sums the gzipped size of the built renderer assets (apps/editor/out/renderer)
 *  and compares against a committed baseline. Reports a warning when total grows
 *  beyond the threshold so PRs that drag in a large dependency or accrete dead
 *  code surface it. Soft by default (never fails the build); pass --check to make
 *  a regression exit non-zero, or --update to (re)write the baseline.
 *
 *  Usage:
 *    node scripts/bench/bundle-size.mjs            # report vs baseline (soft)
 *    node scripts/bench/bundle-size.mjs --update   # write baseline from current build
 *    node scripts/bench/bundle-size.mjs --check    # exit 1 if over threshold (CI gate)
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const rendererDir = join(repoRoot, 'apps/editor/out/renderer')
const baselinePath = join(repoRoot, 'apps/editor/bench/baselines/bundle-size.json')

// Total may legitimately drift between runs; only flag growth past this fraction.
const THRESHOLD = 0.1

const args = new Set(process.argv.slice(2))
const update = args.has('--update')
const check = args.has('--check')

/** Recursively collect bundle asset files under a directory. */
function collectAssets(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectAssets(full))
    } else if (/\.(js|css)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function fmt(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`
}

function measure() {
  const files = collectAssets(rendererDir)
  if (files.length === 0) {
    console.error(`[bundle-size] no renderer assets under ${rendererDir} — run \`pnpm build\` first.`)
    process.exit(1)
  }
  let rawTotal = 0
  let gzipTotal = 0
  const perFile = []
  for (const file of files) {
    const buf = readFileSync(file)
    const gz = gzipSync(buf).length
    rawTotal += statSync(file).size
    gzipTotal += gz
    perFile.push({ file: file.slice(rendererDir.length + 1).replace(/\\/g, '/'), gzip: gz })
  }
  perFile.sort((a, b) => b.gzip - a.gzip)
  return { fileCount: files.length, rawTotal, gzipTotal, perFile }
}

const current = measure()
console.log(
  `[bundle-size] renderer: ${current.fileCount} files, ${fmt(current.rawTotal)} raw, ${fmt(current.gzipTotal)} gzip`,
)
console.log('[bundle-size] largest (gzip):')
for (const f of current.perFile.slice(0, 5)) {
  console.log(`  ${fmt(f.gzip).padStart(12)}  ${f.file}`)
}

if (update) {
  const payload = {
    gzipTotal: current.gzipTotal,
    rawTotal: current.rawTotal,
    fileCount: current.fileCount,
  }
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`[bundle-size] baseline written to ${baselinePath}`)
  process.exit(0)
}

if (!existsSync(baselinePath)) {
  console.warn(
    `[bundle-size] no baseline at ${baselinePath} — run \`pnpm bundle-size:update\` to create one.`,
  )
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const delta = current.gzipTotal - baseline.gzipTotal
const ratio = baseline.gzipTotal > 0 ? delta / baseline.gzipTotal : 0
const sign = delta >= 0 ? '+' : '−'
console.log(
  `[bundle-size] vs baseline: ${fmt(baseline.gzipTotal)} → ${fmt(current.gzipTotal)} (${sign}${fmt(Math.abs(delta))}, ${(ratio * 100).toFixed(1)}%)`,
)

if (ratio > THRESHOLD) {
  console.warn(
    `[bundle-size] ⚠ gzip total grew ${(ratio * 100).toFixed(1)}% (> ${(THRESHOLD * 100).toFixed(0)}% threshold).`,
  )
  if (check) process.exit(1)
} else {
  console.log('[bundle-size] within threshold ✓')
}
