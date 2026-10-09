#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  One-time migration (plus its permanent fidelity check): the old grouped
 *  `release-notes.json` → the frozen aggregate docs/release-notes/archive/legacy.md.
 *
 *    node migrate-legacy.mjs --dry-run     # report what would be written/removed, no writes
 *    node migrate-legacy.mjs               # write the archive, then drop the split files
 *    node migrate-legacy.mjs --check       # verify the committed archive still matches the JSON
 *    node migrate-legacy.mjs --force       # rewrite an existing archive (only for a redo)
 *
 *  Not part of the release path: it ran once to fold the 88 versions released before the
 *  Markdown source of truth existed into one aggregate — a section per version, separated by
 *  `<!-- release-note: X.Y.Z -->` marker lines (splitAggregate in source.mjs reads it back).
 *  The archive is frozen: --check asserts it is still byte-equal to the pre-migration JSON,
 *  and the test suite re-asserts that against the frozen fixture in __tests__/fixtures/.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBody } from './markdown.mjs'
import {
  REPO_ROOT,
  isValidDate,
  isValidVersion,
  legacySectionMarker,
  parseFrontmatter,
  splitAggregate,
} from './source.mjs'

/**
 * The pre-migration JSON, frozen as a test fixture: apps/editor/resources/release-notes.json
 * is now a compiled artifact, so the fixture is the only surviving copy of the grouped form.
 */
export const LEGACY_FIXTURE_PATH = join(
  REPO_ROOT,
  'scripts/release/__tests__/fixtures/legacy-release-notes.json',
)
export const NOTES_DIR_DEFAULT = join(REPO_ROOT, 'docs/release-notes')
export const LEGACY_ARCHIVE_REL = 'archive/legacy.md'

const GROUP_TYPES = ['feat', 'fix', 'other']

/**
 * Inline control characters that would change meaning in the archived line — exactly the
 * ones both renderers can escape (`markdownRenderer.ts` escapable set includes `\`, `*`,
 * `_`, `[`, `]`, `<`, `>`), so the visible text is unchanged. Deliberately minimal:
 * parentheses are inert once `[`/`]` cannot open a link, code spans stay code spans, and
 * `~`/`&` only change meaning in pairs or as entities the archived text does not contain.
 */
const ESCAPE = /[*_\\[\]<>]/

/**
 * Escape the old plain text so it renders exactly as written. Code spans (backticks) are
 * preserved verbatim — the pre-markdown notes already used them as intended formatting.
 */
export function escapeLegacyText(text) {
  let out = ''
  let inCode = false
  for (const ch of text) {
    if (ch === '`') {
      inCode = !inCode
      out += ch
      continue
    }
    out += !inCode && ESCAPE.test(ch) ? `\\${ch}` : ch
  }
  return out
}

export function readLegacyJson(path) {
  const entries = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(entries)) throw new Error(`${path}: 顶层必须是数组`)
  if (entries.some((entry) => entry?.body !== undefined && entry?.groups === undefined)) {
    throw new Error(
      `${path}: 这是编译产物（运行时 release-notes.json，条目带 body 无 groups）；` +
        `迁移需要迁移前的分组 JSON，请用 --from 指定（默认 ${LEGACY_FIXTURE_PATH}）`,
    )
  }
  const seen = new Set()
  return entries.map((entry, index) => {
    const label = `${path}[${index}]`
    if (entry === null || typeof entry !== 'object') throw new Error(`${label}: 条目必须是对象`)
    if (!isValidVersion(entry.version)) throw new Error(`${label}: version 非法：${entry.version}`)
    if (seen.has(entry.version)) throw new Error(`${label}: version ${entry.version} 重复`)
    seen.add(entry.version)
    if (entry.date !== undefined && !isValidDate(entry.date)) {
      throw new Error(`${label}: date 非法：${entry.date}`)
    }
    if (!Array.isArray(entry.groups)) throw new Error(`${label}: groups 必须是数组`)
    const groups = entry.groups.map((group, groupIndex) => {
      const groupLabel = `${label}.groups[${groupIndex}]`
      if (group === null || typeof group !== 'object') throw new Error(`${groupLabel}: 必须是对象`)
      if (!GROUP_TYPES.includes(group.type))
        throw new Error(`${groupLabel}: type 非法：${group.type}`)
      if (typeof group.title !== 'string' || group.title === '') {
        throw new Error(`${groupLabel}: title 必须是非空字符串`)
      }
      if (!Array.isArray(group.items)) throw new Error(`${groupLabel}: items 必须是数组`)
      for (const item of group.items) {
        if (typeof item !== 'string' || item === '') {
          throw new Error(`${groupLabel}: 条目必须是非空字符串：${JSON.stringify(item)}`)
        }
        if (item.includes('\n')) throw new Error(`${groupLabel}: 条目不允许换行：${item}`)
      }
      return { type: group.type, title: group.title, items: [...group.items] }
    })
    return {
      version: entry.version,
      date: entry.date,
      groups,
    }
  })
}

/** Verbatim body: group titles become `##` sections, items become list entries. */
export function legacyBody(entry) {
  const blocks = entry.groups.map((group) => {
    const lines = [`## ${escapeLegacyText(group.title)}`, '']
    for (const item of group.items) lines.push(`- ${escapeLegacyText(item)}`)
    return lines.join('\n')
  })
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`
}

export function legacyNoteText(entry) {
  const lines = ['---', `version: ${entry.version}`]
  if (entry.date !== undefined) lines.push(`date: ${entry.date}`)
  lines.push('status: reviewed', 'legacy: true', '---')
  const frontmatter = lines.join('\n')
  const body = legacyBody(entry)
  return body === '' ? `${frontmatter}\n` : `${frontmatter}\n\n${body}`
}

/**
 * The aggregate archive: one marker line + one note per version, joined by a blank line.
 * This is the format authority for `archive/*.md` — `splitAggregate` reads it back and
 * `--check` compares a whole file against it byte for byte, so any change here invalidates
 * the committed archive (that is why the shape is asserted by tests, not by formatting).
 */
export function legacyArchiveText(entries) {
  return entries
    .map((entry) => `${legacySectionMarker(entry.version)}\n${legacyNoteText(entry)}`)
    .join('\n')
}

/**
 * Resolve code spans to their content on both sides of the comparison: the source keeps
 * the delimiters, the parsed token stream does not. ` `` `true` `` ` → `` `true` ``.
 */
function normalizeCodeSpans(text) {
  return text.replace(/(`+)([\s\S]*?)\1/g, (_, _delimiter, content) => content.trim())
}

/** Content structure of an archived body, for the lossless comparison. */
export function contentStructure(body) {
  if (body === '') return []
  const { tokens } = parseBody(body)
  const out = []
  let pending = undefined
  for (const token of tokens) {
    if (token.type === 'heading_open') pending = { kind: 'heading' }
    else if (token.type === 'list_item_open') pending = { kind: 'item' }
    else if (token.type === 'inline' && pending) {
      // The extracted content already has code-span delimiters resolved.
      out.push({ ...pending, text: inlineText(token.children ?? []) })
      pending = undefined
    } else if (token.type === 'bullet_list_close' || token.type === 'list_item_close') {
      pending = undefined
    }
  }
  return out
}

export function expectedStructure(entry) {
  const out = []
  for (const group of entry.groups) {
    out.push({ kind: 'heading', text: normalizeCodeSpans(group.title) })
    for (const item of group.items) out.push({ kind: 'item', text: normalizeCodeSpans(item) })
  }
  return out
}

function inlineText(children) {
  let out = ''
  for (const child of children) {
    if (child.children) out += inlineText(child.children)
    else if (child.type === 'softbreak' || child.type === 'hardbreak') out += '\n'
    else if (child.type === 'link_open' || child.type === 'link_close') continue
    else out += child.content
  }
  return out
}

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/**
 * What a migration would do, without touching the disk. The split files this run will
 * delete are checked against the generator's own output first: a `<version>.md` that no
 * longer matches (hand-edited, or a partial earlier run) blocks the migration instead of
 * being destroyed. Only versions present in `entries` are ever considered — a new-style
 * note (above the legacy ceiling) is never a candidate.
 */
export function planMigration({ entries, notesDir }) {
  const archivePath = join(notesDir, ...LEGACY_ARCHIVE_REL.split('/'))
  const splitFiles = []
  const modified = []
  for (const entry of entries) {
    const path = join(notesDir, `${entry.version}.md`)
    if (!existsSync(path)) continue
    splitFiles.push(`${entry.version}.md`)
    if (readFileSync(path, 'utf8') !== legacyNoteText(entry)) modified.push(`${entry.version}.md`)
  }
  return { archivePath, archiveText: legacyArchiveText(entries), splitFiles, modified }
}

/** Compare the committed archive with the JSON it came from — no file is written. */
export function compareArchive({ entries, notesDir }) {
  const archivePath = join(notesDir, ...LEGACY_ARCHIVE_REL.split('/'))
  const problems = []
  for (const version of planMigration({ entries, notesDir }).splitFiles) {
    problems.push(`仍存在旧的 ${version} 分文件（迁移未完成）`)
  }
  if (!existsSync(archivePath)) {
    problems.push(`缺少归档 ${LEGACY_ARCHIVE_REL}`)
    return problems
  }
  const text = readFileSync(archivePath, 'utf8')
  if (text !== legacyArchiveText(entries)) {
    problems.push(...diffArchive({ entries, text }))
    return problems
  }
  // Byte-equal to the generator's output, but still re-parse and compare the content
  // structure: this is the check that would catch a generator that silently drops items.
  for (const section of splitAggregate(text, { label: LEGACY_ARCHIVE_REL })) {
    const { body } = parseFrontmatter(section.text, LEGACY_ARCHIVE_REL)
    const entry = entries.find((item) => item.version === section.version)
    const actual = contentStructure(body)
    if (JSON.stringify(actual) !== JSON.stringify(expectedStructure(entry))) {
      problems.push(`${LEGACY_ARCHIVE_REL}（${section.version} 分节）内容与旧 JSON 不等价`)
    }
  }
  return problems
}

/** Which sections of an aggregate drifted from the generator's output — located, not dumped. */
function diffArchive({ entries, text }) {
  let actual
  try {
    actual = splitAggregate(text, { label: LEGACY_ARCHIVE_REL })
  } catch (error) {
    return [`${LEGACY_ARCHIVE_REL} 无法解析：${errorMessage(error)}`]
  }
  const byVersion = new Map(actual.map((section) => [section.version, section.text]))
  const problems = []
  for (const entry of entries) {
    const section = byVersion.get(entry.version)
    if (section === undefined) problems.push(`${LEGACY_ARCHIVE_REL} 缺少 ${entry.version} 分节`)
    else if (section !== legacyNoteText(entry)) {
      problems.push(`${LEGACY_ARCHIVE_REL}（${entry.version} 分节）与旧 JSON 的归档文本不一致`)
    }
  }
  const known = new Set(entries.map((entry) => entry.version))
  for (const section of actual) {
    if (!known.has(section.version)) {
      problems.push(`${LEGACY_ARCHIVE_REL} 多出旧 JSON 中没有的 ${section.version} 分节`)
    }
  }
  return problems
}

/**
 * Fold the split notes into the aggregate archive and remove them. Order matters: the
 * archive is written (and verified) before anything is deleted, and the deletions only
 * touch files already proven byte-equal to the generator's output — so a mistake leaves
 * the sources in place rather than losing them.
 */
export function migrate({ entries, notesDir, force = false, dryRun = false }) {
  const { archivePath, archiveText, splitFiles, modified } = planMigration({ entries, notesDir })
  if (modified.length > 0) {
    throw new Error(
      `拒绝迁移：${modified.join('、')} 与旧 JSON 的归档文本不一致（可能被手工修改）；` +
        '迁移会删除这些文件，请先核对或还原',
    )
  }
  const exists = existsSync(archivePath)
  if (exists && !force && readFileSync(archivePath, 'utf8') !== archiveText) {
    throw new Error(
      `${LEGACY_ARCHIVE_REL} 已存在且与旧 JSON 不一致；核对后用 --force 重写`,
    )
  }
  // Writing is skipped when the archive is already exact, but the cleanup still runs:
  // a half-finished migration (archive written, split files left behind) converges here.
  const writing = !exists || force
  const removed = [...splitFiles]
  if (dryRun) return { archivePath, written: writing, skipped: !writing, removed }
  if (writing) {
    mkdirSync(dirname(archivePath), { recursive: true })
    writeFileSync(archivePath, archiveText, 'utf8')
  }
  for (const name of splitFiles) rmSync(join(notesDir, name))
  return { archivePath, written: writing, skipped: !writing, removed }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') out.check = true
    else if (arg === '--force') out.force = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--from') out.from = argv[++i]
    else if (arg === '--out') out.out = argv[++i]
    else throw new Error(`无法识别参数：${arg}`)
  }
  return out
}

function main(argv) {
  const args = parseArgs(argv)
  const from = args.from ? resolve(REPO_ROOT, args.from) : LEGACY_FIXTURE_PATH
  const notesDir = args.out ? resolve(REPO_ROOT, args.out) : NOTES_DIR_DEFAULT
  const entries = readLegacyJson(from)

  if (args.check) {
    const problems = compareArchive({ entries, notesDir })
    if (problems.length > 0) {
      throw new Error(`归档与旧 JSON 不一致：\n  - ${problems.join('\n  - ')}`)
    }
    console.log(`legacy 归档校验通过：${entries.length} 个版本与 ${from} 一致`)
    return
  }

  const result = migrate({
    entries,
    notesDir,
    force: args.force === true,
    dryRun: args.dryRun === true,
  })
  const verb = args.dryRun ? '将' : ''
  console.log(
    `${args.dryRun ? 'legacy 归档预检（--dry-run，未写盘）' : 'legacy 归档完成'}：` +
      `${result.written ? `${verb}写入 ${LEGACY_ARCHIVE_REL}` : `${LEGACY_ARCHIVE_REL} 已是最新（未重写）`}` +
      `（${entries.length} 个版本），${verb}清理旧分文件 ${result.removed.length} 个 → ${notesDir}`,
  )
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`\x1b[31m✗ ${error instanceof Error ? error.message : String(error)}\x1b[0m`)
    process.exit(1)
  }
}
