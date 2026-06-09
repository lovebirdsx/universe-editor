#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generate apps/editor/resources/release-notes.json from git history.
 *
 *  Each git tag `vX.Y.Z` is one released version; commits in `<prevTag>..<tag>`
 *  are collected and grouped by Conventional-Commit type. Pass
 *  `--pending-version X.Y.Z` before creating the tag to prepend notes for the
 *  unreleased `<latestTag>..HEAD` range. Only commits marked with `!`
 *  (e.g. `feat!: …` or `fix(scope)!: …`) are included; commits without `!`
 *  are always excluded regardless of type.
 *
 *  Zero deps — Node built-ins + system git only (matches upload.mjs).
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')
const OUT_FILE = resolve(REPO_ROOT, 'apps/editor/resources/release-notes.json')

/** Known types used for grouping; `!` commits of other types land in `other`. */
const KNOWN_TYPES = new Set(['feat', 'fix', 'perf', 'security'])
/** Group order + localized headings. */
const GROUP_ORDER = [
  ['feat', '新功能'],
  ['fix', 'Bug 修复'],
  ['perf', '性能优化'],
  ['security', '安全修复'],
  ['other', '其他变更'],
]

/**
 * Parse a commit subject. Returns `{ type, group, summary }` when the
 * commit qualifies for release notes (must have `!`), or `null` otherwise.
 */
export function parseCommit(subject) {
  const m = /^(\w+)(?:\([^)]*\))?!:\s*(.+)$/.exec(subject.trim())
  if (!m) return null
  const [, type, summary] = m
  const group = KNOWN_TYPES.has(type) ? type : 'other'
  return { type, group, summary: summary.trim() }
}

/** Build the `groups` array for one version from its commit subjects. */
export function buildGroups(subjects) {
  const buckets = new Map()
  for (const s of subjects) {
    const parsed = parseCommit(s)
    if (!parsed) continue
    if (!buckets.has(parsed.group)) buckets.set(parsed.group, [])
    buckets.get(parsed.group).push(parsed.summary)
  }
  const groups = []
  for (const [type, title] of GROUP_ORDER) {
    const items = buckets.get(type)
    if (items && items.length > 0) groups.push({ type, title, items })
  }
  return groups
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

function listTags() {
  const out = git(['tag', '--list', 'v*', '--sort=v:refname'])
  return out ? out.split('\n').filter(Boolean) : []
}

function commitSubjects(fromTag, toTag) {
  const range = fromTag ? `${fromTag}..${toTag}` : toTag
  const out = git(['log', range, '--no-merges', '--pretty=format:%s'])
  return out ? out.split('\n') : []
}

function tagDate(tag) {
  return git(['log', '-1', '--format=%cs', tag])
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pending-version') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) throw new Error('缺少 --pending-version 的版本号')
      out.pendingVersion = next
      i++
    }
  }
  return out
}

export function generateNotes(options = {}) {
  const { pendingVersion } = options
  const tags = listTags()
  const notes = tags.map((tag, i) => ({
    version: tag.replace(/^v/, ''),
    date: tagDate(tag),
    groups: buildGroups(commitSubjects(i > 0 ? tags[i - 1] : '', tag)),
  }))
  if (pendingVersion) {
    const pendingTag = `v${pendingVersion}`
    if (!tags.includes(pendingTag)) {
      const lastTag = tags.at(-1) ?? ''
      notes.push({
        version: pendingVersion,
        date: today(),
        groups: buildGroups(commitSubjects(lastTag, 'HEAD')),
      })
    }
  }
  notes.reverse() // newest first
  return notes
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`release-notes: ${error.message}`)
    process.exit(1)
  }
  const notes = generateNotes(args)
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(notes, null, 2) + '\n', 'utf8')
  const total = notes.reduce(
    (sum, n) => sum + n.groups.reduce((s, g) => s + g.items.length, 0),
    0,
  )
  console.log(`release-notes: ${notes.length} version(s), ${total} entr(ies) → ${OUT_FILE}`)
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
