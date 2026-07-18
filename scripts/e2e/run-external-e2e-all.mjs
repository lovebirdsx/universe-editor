#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  run-external-e2e-all.mjs — run every out-of-workspace extension's e2e suite.
 *
 *  The `extensions-external/*` extensions are NOT in the pnpm/turbo workspace, so
 *  the root `e2e` (turbo) script can't reach them. This orchestrator builds the
 *  editor once (the suites run its packaged `out/`), then runs each external
 *  suite's own `e2e` script in sequence (serial, mirroring the `--concurrency=1`
 *  of the turbo e2e run: each suite cold-launches its own Electron).
 *
 *  Usage:  node scripts/e2e/run-external-e2e-all.mjs [--regression]
 *          (root `pnpm e2e:external` / `pnpm e2ea:external`)
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

const regression = process.argv.slice(2).includes('--regression')

// Extension dirs that own an e2e suite (a package.json `e2e` script).
const SUITES = ['eslint', 'pdf', 'excel-diff']

const isWin = process.platform === 'win32'

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...opts })
  if (res.error) throw res.error
  return res.status ?? 1
}

// On Windows, Node refuses to spawn `.cmd` files without a shell (EINVAL since the
// CVE-2024-27980 fix), so npm runs go through the shell there.
function runNpm(args, opts = {}) {
  return isWin
    ? run('npm', args, { shell: true, ...opts })
    : run('npm', args, opts)
}

// Build the editor once; the suites all run against its packaged out/.
console.log('› building editor for external e2e…')
const build = run(process.execPath, [
  resolve(repoRoot, 'node_modules/turbo/bin/turbo'),
  'run',
  'build',
  '--filter=@universe-editor/editor',
])
if (build !== 0) process.exit(build)

let failed = 0
for (const suite of SUITES) {
  const dir = resolve(repoRoot, 'extensions-external', suite)
  if (!existsSync(resolve(dir, 'e2e/playwright.config.ts'))) {
    console.log(`› skip ${suite} (no e2e suite)`)
    continue
  }
  console.log(`\n› external e2e: ${suite}${regression ? ' (+@regression)' : ''}`)
  const status = runNpm(['run', regression ? 'e2ea' : 'e2e'], { cwd: dir })
  if (status !== 0) failed++
}

if (failed > 0) {
  console.error(`\n✗ ${failed} external e2e suite(s) failed`)
  process.exit(1)
}
console.log('\n✓ all external e2e suites passed')
