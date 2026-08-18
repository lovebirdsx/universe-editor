#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Runs the editor's three tsgo passes with a one-shot self-heal: on failure, drop the
 *  package's incremental state and retry once. tsgo --build trusts tsbuildinfo freshness by
 *  mtime order, and clock skew (WSL RTC drift) can leave that state poisoned — the manual
 *  fix documented in memory was exactly "delete these three files and rerun"; this automates
 *  it. A retry pass that still fails is a real type error.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const editorDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BUILDINFO = ['dist/.tsbuildinfo-node', 'dist/.tsbuildinfo-web', 'integration/tsconfig.tsbuildinfo']

const STEPS = [
  ['--build', 'integration/tsconfig.json'],
  ['--project', 'bench/tsconfig.json'],
  ['--project', 'e2e/tsconfig.json'],
]

function runTypecheck() {
  for (const args of STEPS) {
    const result = spawnSync('pnpm', ['exec', 'tsgo', ...args], {
      cwd: editorDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) return false
  }
  return true
}

if (runTypecheck()) process.exit(0)

console.error(
  '[typecheck] failed — clearing tsbuildinfo and retrying once (stale incremental state guard)',
)
for (const rel of BUILDINFO) rmSync(resolve(editorDir, rel), { force: true })

if (runTypecheck()) {
  console.log('[typecheck] passed after clearing tsbuildinfo — incremental state was stale')
  process.exit(0)
}
console.error(
  '[typecheck] failed again with fresh state — real type error, or stale upstream dist (try `turbo run build --force`)',
)
process.exit(1)
