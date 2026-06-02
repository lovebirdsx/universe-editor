#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generate apps/editor/resources/release-notes.json from git history.
 *
 *  Each git tag `vX.Y.Z` is one released version; commits in `<prevTag>..<tag>`
 *  are collected and grouped by Conventional-Commit type. Only user-facing types
 *  (feat/fix/perf/security) are included by default; any other type may opt in by
 *  marking the commit breaking with `!` (e.g. `refactor(core)!: …`). See
 *  docs/development/git-commit-msg-rule.md.
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

/** Types shown in release notes by default (others need a `!` breaking marker). */
const DEFAULT_TYPES = new Set(['feat', 'fix', 'perf', 'security'])
/** Group order + localized headings. Non-default breaking commits land in `other`. */
const GROUP_ORDER = [
  ['feat', '新功能'],
  ['fix', 'Bug 修复'],
  ['perf', '性能优化'],
  ['security', '安全修复'],
  ['other', '其他变更'],
]

/**
 * Parse a commit subject. Returns `{ type, group, breaking, summary }` when the
 * commit qualifies for release notes, or `null` when it doesn't (wrong format or
 * an excluded type without `!`).
 */
export function parseCommit(subject) {
  const m = /^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/.exec(subject.trim())
  if (!m) return null
  const [, type, bang, summary] = m
  const breaking = bang === '!'
  if (!DEFAULT_TYPES.has(type) && !breaking) return null
  const group = DEFAULT_TYPES.has(type) ? type : 'other'
  return { type, group, breaking, summary: summary.trim() }
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

export function generateNotes() {
  const tags = listTags()
  const notes = tags.map((tag, i) => ({
    version: tag.replace(/^v/, ''),
    date: tagDate(tag),
    groups: buildGroups(commitSubjects(i > 0 ? tags[i - 1] : '', tag)),
  }))
  notes.reverse() // newest first
  return notes
}

function main() {
  const notes = generateNotes()
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
