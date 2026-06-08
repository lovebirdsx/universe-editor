#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Installs vendored npm projects (outside the pnpm workspace) only when their
 *  package-lock.json changed.
 *
 *  `npm ci` wipes and reinstalls node_modules every time — the heaviest fixed
 *  cost of the packaging chain (runtime:stage runs it on every package:win).
 *  We hash each lockfile into node_modules/.install-stamp and skip `npm ci`
 *  when the installed tree already matches.
 *
 *  Vendors:
 *   - vendor/claude-agent-acp           (git submodule; built afterwards by agent:build)
 *   - vendor/typescript-language-server (prebuilt npm package; no build step)
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

const VENDOR_DIRS = ['vendor/claude-agent-acp', 'vendor/typescript-language-server']

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function lockHash(lockFile) {
  return createHash('sha256').update(readFileSync(lockFile)).digest('hex')
}

function isFresh(nodeModules, stampFile, lockFile) {
  if (!existsSync(nodeModules) || !existsSync(stampFile)) return false
  try {
    return readFileSync(stampFile, 'utf8').trim() === lockHash(lockFile)
  } catch {
    return false
  }
}

for (const rel of VENDOR_DIRS) {
  const dir = join(repoRoot, rel)
  const lockFile = join(dir, 'package-lock.json')
  const nodeModules = join(dir, 'node_modules')
  const stampFile = join(nodeModules, '.install-stamp')

  if (!existsSync(lockFile)) {
    console.error(`[vendor-install] missing lockfile for ${rel} (run \`git submodule update --init\`?)`)
    process.exit(1)
  }

  if (isFresh(nodeModules, stampFile, lockFile)) {
    console.log(`[vendor-install] ${rel} up to date — skipping npm ci`)
    continue
  }

  console.log(`[vendor-install] installing ${rel} (npm ci)…`)
  execFileSync(npm, ['ci'], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  writeFileSync(stampFile, lockHash(lockFile))
}
