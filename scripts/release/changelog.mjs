#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generate apps/editor/resources/release-notes.json from git history.
 *
 *  Each git tag `vX.Y.Z` is one released version; commits in `<prevTag>..<tag>`
 *  are collected and grouped by Conventional-Commit type. Only commits marked with `!`
 *  (e.g. `feat!: …` or `fix(scope)!: …`) are included; commits without `!`
 *  are always excluded regardless of type.
 *
 *  Two modes:
 *    --version X.Y.Z   Incremental: recompute only that version and merge into existing JSON.
 *                      If the tag exists, uses prevTag..tag; otherwise uses lastTag..HEAD.
 *    (no args)         Full rebuild: regenerate all versions from scratch.
 *
 *  Zero deps — Node built-ins + system git only (matches upload.mjs).
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
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
    if (a === '--version') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) throw new Error('缺少 --version 的版本号')
      out.version = next
      i++
    }
  }
  return out
}

function computeVersionEntry(version, tags) {
  const tag = `v${version}`
  const idx = tags.indexOf(tag)
  if (idx >= 0) {
    const prev = idx > 0 ? tags[idx - 1] : ''
    return { version, date: tagDate(tag), groups: buildGroups(commitSubjects(prev, tag)) }
  }
  const lastTag = tags.at(-1) ?? ''
  return { version, date: today(), groups: buildGroups(commitSubjects(lastTag, 'HEAD')) }
}

export function generateNotes(options = {}) {
  const tags = listTags()
  if (options.version) {
    let notes = []
    try {
      notes = JSON.parse(readFileSync(OUT_FILE, 'utf8'))
    } catch {}
    const entry = computeVersionEntry(options.version, tags)
    const idx = notes.findIndex((n) => n.version === options.version)
    if (idx >= 0) notes[idx] = entry
    else notes.unshift(entry)
    return notes
  }
  const notes = tags.map((tag, i) => ({
    version: tag.replace(/^v/, ''),
    date: tagDate(tag),
    groups: buildGroups(commitSubjects(i > 0 ? tags[i - 1] : '', tag)),
  }))
  notes.reverse()
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
