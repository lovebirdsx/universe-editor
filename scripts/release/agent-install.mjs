#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Installs vendor/claude-agent-acp deps only when package-lock.json changed.
 *
 *  `npm ci` wipes and reinstalls node_modules every time — the heaviest fixed
 *  cost of the packaging chain (runtime:stage runs it on every package:win).
 *  We hash the lockfile into node_modules/.install-stamp and skip `npm ci`
 *  when the installed tree already matches.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const agentDir = join(repoRoot, 'vendor/claude-agent-acp')
const lockFile = join(agentDir, 'package-lock.json')
const nodeModules = join(agentDir, 'node_modules')
const stampFile = join(nodeModules, '.install-stamp')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const lockHash = () => createHash('sha256').update(readFileSync(lockFile)).digest('hex')

const isFresh = () => {
  if (!existsSync(nodeModules) || !existsSync(stampFile)) return false
  try {
    return readFileSync(stampFile, 'utf8').trim() === lockHash()
  } catch {
    return false
  }
}

if (isFresh()) {
  console.log('[agent-install] vendor deps up to date — skipping npm ci')
} else {
  console.log('[agent-install] installing vendor deps (npm ci)…')
  execFileSync(npm, ['ci'], {
    cwd: agentDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  writeFileSync(stampFile, lockHash())
}
