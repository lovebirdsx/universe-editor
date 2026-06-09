#!/usr/bin/env node
/**
 * Visual regression diff tool.
 *
 * Compares PNG files in --baseline dir against --current dir using pixelmatch.
 * Outputs diff images to --output dir and prints a summary.
 * Exits with code 1 if any image exceeds the pixel-difference threshold.
 *
 * Usage:
 *   node diff.js --baseline=e2e/baselines --current=e2e/test-results/visual --output=e2e/diff
 *   # or via tsx for TypeScript source:
 *   tsx scripts/visual-regression/diff.ts --baseline=... --current=... --output=...
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, mkdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArg(name: string): string {
  const prefix = `--${name}=`
  const arg = process.argv.find((a) => a.startsWith(prefix))
  if (!arg) {
    console.error(`Missing required argument: ${prefix}<path>`)
    process.exit(2)
  }
  return arg.slice(prefix.length)
}

const baselineDir = parseArg('baseline')
const currentDir = parseArg('current')
const outputDir = parseArg('output')

// Fail if total changed pixels as a fraction of image size exceeds this.
const THRESHOLD = 0.01 // 1%

// ---------------------------------------------------------------------------
// PNG helpers
// ---------------------------------------------------------------------------

async function readPng(path: string): Promise<PNG> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('error', reject)
    const png = new PNG()
    stream
      .pipe(png)
      .on('parsed', () => resolve(png))
      .on('error', reject)
  })
}

async function writePng(png: PNG, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path)
    out.on('error', reject).on('finish', resolve)
    png.pack().pipe(out)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface DiffResult {
  name: string
  diffPixels: number
  totalPixels: number
  diffFraction: number
  status: 'pass' | 'fail' | 'missing'
}

async function run(): Promise<void> {
  await mkdir(outputDir, { recursive: true })

  const baselineFiles = (await readdir(baselineDir)).filter((f) => f.endsWith('.png'))

  if (baselineFiles.length === 0) {
    console.log('No baseline PNG files found — nothing to compare.')
    return
  }

  const results: DiffResult[] = []
  let anyFailed = false

  for (const file of baselineFiles) {
    const baselinePath = join(baselineDir, file)
    const currentPath = join(currentDir, file)
    const diffPath = join(outputDir, `diff-${file}`)

    // Check if current screenshot exists.
    const exists = await stat(currentPath).then(
      () => true,
      () => false,
    )
    if (!exists) {
      console.warn(`  MISSING  ${file} — no current screenshot found`)
      results.push({
        name: file,
        diffPixels: 0,
        totalPixels: 0,
        diffFraction: 1,
        status: 'missing',
      })
      anyFailed = true
      continue
    }

    const baseline = await readPng(baselinePath)
    const current = await readPng(currentPath)

    const { width, height } = baseline
    if (current.width !== width || current.height !== height) {
      console.warn(
        `  SIZE MISMATCH  ${file}: baseline ${width}×${height} vs current ${current.width}×${current.height}`,
      )
      results.push({
        name: file,
        diffPixels: -1,
        totalPixels: width * height,
        diffFraction: 1,
        status: 'fail',
      })
      anyFailed = true
      continue
    }

    const diff = new PNG({ width, height })
    const diffPixels = pixelmatch(
      baseline.data,
      current.data,
      diff.data,
      width,
      height,
      { threshold: 0.1 }, // per-pixel color sensitivity (separate from the pass/fail threshold)
    )

    const totalPixels = width * height
    const diffFraction = diffPixels / totalPixels
    const status = diffFraction <= THRESHOLD ? 'pass' : 'fail'

    if (status === 'fail') {
      anyFailed = true
      await writePng(diff, diffPath)
    }

    results.push({ name: file, diffPixels, totalPixels, diffFraction, status })
  }

  // Print summary table.
  console.log('\n── Visual Regression Diff Summary ─────────────────────────────')
  console.log(`${'File'.padEnd(40)} ${'Diff px'.padStart(8)} ${'% diff'.padStart(8)}  Status`)
  console.log('─'.repeat(68))
  for (const r of results) {
    const pct =
      r.totalPixels > 0 ? ((r.diffFraction * 100).toFixed(2) + '%').padStart(8) : '      N/A'
    const px = r.diffPixels >= 0 ? String(r.diffPixels).padStart(8) : '     N/A'
    const icon = r.status === 'pass' ? '✓' : '✗'
    console.log(`${r.name.padEnd(40)} ${px} ${pct}  ${icon} ${r.status.toUpperCase()}`)
  }
  console.log('─'.repeat(68))

  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status !== 'pass').length
  console.log(`\n${passed} passed, ${failed} failed out of ${results.length} images`)

  if (anyFailed) {
    console.log(`\nDiff images written to: ${outputDir}`)
    process.exit(1)
  }
}

run().catch((err: unknown) => {
  console.error('diff script error:', err)
  process.exit(2)
})
