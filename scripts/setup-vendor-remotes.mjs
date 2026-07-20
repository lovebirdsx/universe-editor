#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  setup-vendor-remotes.mjs — configure the `upstream` git remote on each vendored
 *  agent fork submodule.
 *
 *  A git remote is per-clone local state; it does NOT travel with the repository.
 *  So every fresh clone needs `upstream` wired up before it can `git fetch upstream`
 *  to sync the fork against its origin project. This one-shot script does that for
 *  both forks (idempotent — updates the URL if the remote already exists).
 *
 *  Each fork is `lovebirdsx/<name>` on origin; upstream is the project it forks.
 *  See vendor/<fork>/CLAUDE.md for the rebase/sync workflow that uses these remotes.
 *
 *  Usage (from repo root):  node scripts/setup-vendor-remotes.mjs
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const FORKS = [
  {
    dir: 'vendor/claude-agent-acp',
    upstream: 'https://github.com/agentclientprotocol/claude-agent-acp.git',
  },
  {
    dir: 'vendor/codex-acp',
    upstream: 'https://github.com/agentclientprotocol/codex-acp.git',
  },
]

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function existingRemotes(cwd) {
  const set = new Set()
  const out = git(cwd, ['remote'])
  for (const line of out.split(/\r?\n/)) {
    const name = line.trim()
    if (name) set.add(name)
  }
  return set
}

let failures = 0
for (const { dir, upstream } of FORKS) {
  const cwd = join(repoRoot, dir)
  if (!existsSync(join(cwd, '.git')) && !existsSync(cwd)) {
    console.warn(`⚠ ${dir} not checked out — run \`git submodule update --init\` first. Skipped.`)
    failures++
    continue
  }
  try {
    const remotes = existingRemotes(cwd)
    if (remotes.has('upstream')) {
      git(cwd, ['remote', 'set-url', 'upstream', upstream])
      console.log(`✓ ${dir}: upstream URL set → ${upstream}`)
    } else {
      git(cwd, ['remote', 'add', 'upstream', upstream])
      console.log(`✓ ${dir}: upstream added → ${upstream}`)
    }
  } catch (err) {
    console.error(`✗ ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    failures++
  }
}

if (failures > 0) {
  process.exitCode = 1
}
