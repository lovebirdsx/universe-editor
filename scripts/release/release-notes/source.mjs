#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Release-notes source layer: frontmatter parsing, validation, ordering, link policy
 *  and the serialized forms consumed downstream (runtime JSON, site index, GitHub body).
 *
 *  No third-party imports and no wall-clock reads — every output is a pure function of
 *  the committed `docs/release-notes/*.md` sources, so recompiling the same input yields
 *  byte-identical output (that is what makes `--check` and `--resume` meaningful).
 *  Markdown handling lives in markdown.mjs (markdown-it tokens; never regexes).
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(__dirname, '../../..')
export const NOTES_SOURCE_DIR = join(REPO_ROOT, 'docs/release-notes')
export const RUNTIME_JSON_PATH = join(REPO_ROOT, 'apps/editor/resources/release-notes.json')
export const EDITOR_PACKAGE_JSON = join(REPO_ROOT, 'apps/editor/package.json')
export const BUILD_SNAPSHOT_DIR = join(REPO_ROOT, 'apps/editor/.release-notes-build')
export const LINK_POLICY_PATH = join(
  REPO_ROOT,
  'apps/editor/src/shared/releaseNotes/linkPolicy.json',
)

/**
 * Highest version whose notes came from the one-time migration of the old
 * release-notes.json. `legacy: true` is only accepted up to this version, so a future
 * author cannot opt out of the summary/range/non-empty rules by adding the marker.
 */
export const LEGACY_MAX_VERSION = '0.14.9'

export const STATUSES = ['draft', 'reviewed']

const FRONTMATTER_KEYS = new Set([
  'version',
  'date',
  'title',
  'summary',
  'status',
  'sourceFrom',
  'sourceTo',
  'legacy',
])

export const LINK_POLICY = JSON.parse(readFileSync(LINK_POLICY_PATH, 'utf8'))

const docIdPattern = new RegExp(LINK_POLICY.docIdPattern)

export function compareVersions(a, b) {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function parseVersionParts(version) {
  return version.split('.').map((n) => Number.parseInt(n, 10))
}

export function isValidVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(version)
}

export function isValidDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const [year, month, day] = m.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
  )
}

/** Version-note files only; README/_template (and anything `_`-prefixed) never are. */
export function isNoteFileName(name) {
  if (!name.endsWith('.md')) return false
  const stem = name.slice(0, -'.md'.length)
  if (stem.startsWith('_') || stem.toLowerCase() === 'readme') return false
  return true
}

/**
 * Aggregate archive marker (`archive/*.md`): one line per archived version. The marker
 * is stripped before the section ever reaches the Markdown parser — raw HTML is outside
 * the supported subset, so a marker that survived splitting would fail loudly instead
 * of rendering as a comment.
 */
export const LEGACY_SECTION_MARKER_RE = /^<!-- release-note: (\d+\.\d+\.\d+) -->$/

export function legacySectionMarker(version) {
  return `<!-- release-note: ${version} -->`
}

function fail(label, message) {
  throw new Error(`${label}: ${message}`)
}

/** H1 outside fenced code — a `# comment` inside a fence is a comment, not a heading. */
function hasH1(body) {
  let fence
  for (const line of body.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0]
      else if (fence === marker[0]) fence = undefined
      continue
    }
    if (fence === undefined && /^#\s/.test(line)) return true
  }
  return false
}

/**
 * Parse the flattened frontmatter block (`key: value` lines between `---` fences).
 * Deliberately not YAML: nesting, lists, quotes beyond a single wrapping pair and
 * unknown keys are rejected so a typo fails the build instead of being ignored.
 *
 * `lineOffset` lifts the reported line numbers onto the enclosing aggregate file, so a
 * section parsed out of `archive/legacy.md` points at real lines, not section-relative
 * ones. `bodyLine` (the first body line, same absolute frame) lets the Markdown layer
 * lift its token lines the same way.
 */
export function parseFrontmatter(text, label, { lineOffset = 0 } = {}) {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') fail(label, 'frontmatter 缺失：文件必须以 `---` 开头')
  const end = lines.indexOf('---', 1)
  if (end < 0) fail(label, 'frontmatter 未闭合：缺少结束的 `---` 行')
  const fields = new Map()
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\s/.test(line)) fail(label, `第 ${i + 1 + lineOffset} 行：frontmatter 不支持缩进/嵌套`)
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (!match) fail(label, `第 ${i + 1 + lineOffset} 行：frontmatter 行必须是 \`key: value\``)
    const [, key, rawValue] = match
    if (fields.has(key)) fail(label, `第 ${i + 1 + lineOffset} 行：字段 ${key} 重复`)
    fields.set(key, unwrapQuotes(rawValue.trim()))
  }
  const bodyText = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .trimEnd()
  let bodyLine = end + 2 + lineOffset
  for (let i = end + 1; i < lines.length; i++) {
    if (lines[i] !== '') {
      bodyLine = i + 1 + lineOffset
      break
    }
  }
  // An empty body stays `''` — a note with nothing recorded must not serialize as "\n".
  return { fields, body: bodyText === '' ? '' : `${bodyText}\n`, bodyLine }
}

function unwrapQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

/**
 * Parse and validate one version note. `body` keeps the source text verbatim (EOL
 * normalized, trailing whitespace trimmed) — it is what the app renders, so the
 * compiled JSON and the Markdown source never drift in wording. `file` is the note's
 * path relative to the notes dir (it feeds the manifest), and the returned `label`
 * is what error messages call it.
 *
 * An aggregate section passes `expectedVersion` (the marker's version) instead of
 * relying on the file name, plus `lineOffset` so every reported line number points
 * into the enclosing archive file rather than into the section.
 */
export function parseNote(text, { file, expectedVersion, lineOffset = 0 }) {
  const label =
    expectedVersion === undefined ? basename(file) : `${file}（${expectedVersion} 分节）`
  const { fields, body, bodyLine } = parseFrontmatter(text, label, { lineOffset })
  for (const key of fields.keys()) {
    if (!FRONTMATTER_KEYS.has(key))
      fail(label, `未知字段 ${key}（允许：${[...FRONTMATTER_KEYS].join(', ')}）`)
  }

  const version = fields.get('version') ?? ''
  if (!version) fail(label, '缺少必填字段 version')
  if (!isValidVersion(version)) fail(label, `version 必须是 X.Y.Z：${version}`)
  if (expectedVersion === undefined) {
    const stem = basename(file, '.md')
    if (version !== stem) fail(label, `文件名 ${stem}.md 与 frontmatter version ${version} 不一致`)
  } else if (version !== expectedVersion) {
    fail(label, `分节标记 version ${expectedVersion} 与 frontmatter version ${version} 不一致`)
  }

  const legacyRaw = fields.get('legacy')
  if (legacyRaw !== undefined && legacyRaw !== 'true') fail(label, 'legacy 只接受 `true`')
  const legacy = legacyRaw === 'true'
  if (legacy && compareVersions(version, LEGACY_MAX_VERSION) > 0) {
    fail(
      label,
      `legacy 仅用于迁移归档（截至 v${LEGACY_MAX_VERSION}）；新版本请写正式稿，不得用 legacy 绕过校验`,
    )
  }

  const status = fields.get('status') ?? ''
  if (!STATUSES.includes(status))
    fail(label, `status 必须是 ${STATUSES.join(' | ')}：${status || '(空)'}`)
  if (legacy && status !== 'reviewed') fail(label, 'legacy 归档必须标记 status: reviewed')

  const date = fields.get('date')
  if (date === undefined || date === '') {
    if (!legacy) fail(label, '缺少必填字段 date（合法 YYYY-MM-DD）')
  } else if (!isValidDate(date)) {
    fail(label, `date 必须是合法 YYYY-MM-DD：${date}`)
  }

  const title = fields.get('title') ?? ''
  const summary = fields.get('summary') ?? ''
  if (!legacy && status === 'reviewed') {
    if (title === '') fail(label, 'reviewed 正式稿必须有 title')
    if (summary === '') fail(label, 'reviewed 正式稿必须有 summary')
    if (body.trim() === '') fail(label, 'reviewed 正式稿不能是空正文（无用户可见变更请显式写明）')
  }

  const sourceFrom = fields.get('sourceFrom')
  if (sourceFrom !== undefined && !/^v\d+\.\d+\.\d+$/.test(sourceFrom)) {
    fail(label, `sourceFrom 必须是 tag 形式（如 v0.14.9）：${sourceFrom}`)
  }
  const sourceTo = fields.get('sourceTo')
  if (sourceTo !== undefined && !/^[0-9a-f]{7,40}$/.test(sourceTo)) {
    fail(label, `sourceTo 必须是提交 SHA：${sourceTo}`)
  }
  if (!legacy && status === 'reviewed' && sourceFrom === undefined && sourceTo === undefined) {
    fail(label, 'reviewed 正式稿必须记录 sourceFrom / sourceTo（供复核追溯）')
  }

  if (!legacy && hasH1(body)) {
    fail(label, '正文不要写一级标题（版本标题由应用/站点渲染），请从 `## ` 开始')
  }

  return {
    file,
    label,
    version,
    status,
    legacy,
    date: date ? date : undefined,
    title,
    summary,
    sourceFrom: sourceFrom ?? undefined,
    sourceTo: sourceTo ?? undefined,
    bodyLine,
    body,
  }
}

/** Looks like a section marker but does not match its exact shape — reported as such. */
const MARKER_LOOKALIKE_RE = /^<!--\s*release-note\s*:/

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Split one aggregate archive file into its per-version sections. The archive is a
 * frozen, machine-generated artifact (see migrate-legacy.mjs): anything that does not
 * look like the generator's output fails here with an absolute line number instead of
 * being silently mis-split. A marker line inside a fenced code block is an error too —
 * archived bodies never contain fences, so hitting one means the file was hand-edited.
 */
export function splitAggregate(source, { label }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const sections = []
  const seen = new Map()
  let current
  let fence
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const marker = LEGACY_SECTION_MARKER_RE.exec(line)
    if (marker !== null) {
      if (fence !== undefined) {
        fail(
          label,
          `第 ${i + 1} 行：分节标记出现在 fenced code block 内（归档被截断或标记位置写错）`,
        )
      }
      const earlier = seen.get(marker[1])
      if (earlier !== undefined) {
        fail(label, `第 ${i + 1} 行：版本 ${marker[1]} 重复（第 ${earlier + 1} 行已出现）`)
      }
      seen.set(marker[1], i)
      if (current !== undefined) current.endLine = i
      current = { version: marker[1], startLine: i + 1, endLine: lines.length }
      sections.push(current)
      fence = undefined
      continue
    }
    if (fence !== undefined) {
      const close = FENCE_RE.exec(line)?.[1]
      if (close !== undefined && close[0] === fence) fence = undefined
      continue
    }
    const open = FENCE_RE.exec(line)?.[1]
    if (open !== undefined) {
      fence = open[0]
      continue
    }
    if (current === undefined) {
      if (line.trim() === '') continue
      if (MARKER_LOOKALIKE_RE.test(line)) {
        fail(label, `第 ${i + 1} 行：分节标记格式非法（应为 <!-- release-note: X.Y.Z --> 单独一行）`)
      }
      fail(label, `第 ${i + 1} 行：归档文件必须以分节标记开头（<!-- release-note: X.Y.Z -->）`)
    }
    if (MARKER_LOOKALIKE_RE.test(line)) {
      fail(label, `第 ${i + 1} 行：分节标记格式非法（应为 <!-- release-note: X.Y.Z --> 单独一行）`)
    }
  }
  if (sections.length === 0) {
    fail(label, '归档文件没有任何分节标记（<!-- release-note: X.Y.Z -->）')
  }
  return sections.map((section) => ({
    version: section.version,
    text: lines.slice(section.startLine, section.endLine).join('\n'),
    lineOffset: section.startLine,
  }))
}

export function sortNotesNewestFirst(notes) {
  return [...notes].sort((a, b) => compareVersions(b.version, a.version))
}

export function indexNotesByVersion(notes) {
  const byVersion = new Map()
  for (const note of notes) {
    const existing = byVersion.get(note.version)
    if (existing) {
      throw new Error(
        `版本 ${note.version} 有多份正文：${existing.file} 与 ${note.file}（一个版本只能有一份正文）`,
      )
    }
    byVersion.set(note.version, note)
  }
  return byVersion
}

/** Notes that may enter a release: reviewed (or migrated legacy), at most `maxVersion`. */
export function selectReleasableNotes(notes, maxVersion) {
  return sortNotesNewestFirst(notes).filter(
    (note) =>
      (note.legacy || note.status === 'reviewed') &&
      (maxVersion === undefined || compareVersions(note.version, maxVersion) <= 0),
  )
}

export function buildRuntimeEntries(notes) {
  return notes.map((note) => {
    const entry = { version: note.version }
    if (note.date !== undefined) entry.date = note.date
    entry.title = note.title
    entry.summary = note.summary
    entry.body = note.body
    return entry
  })
}

/** Deterministic serialization: fixed key order, 2-space indent, single trailing newline. */
export function serializeRuntimeJson(notes) {
  return `${JSON.stringify(buildRuntimeEntries(notes), null, 2)}\n`
}

/** Site index: metadata + page path only — the download page never fetches full bodies. */
export function buildSiteIndex(notes) {
  return {
    schema: 1,
    versions: notes.map((note) => ({
      version: note.version,
      date: note.date ?? '',
      title: note.title,
      summary: note.summary,
      path: `v${note.version}.html`,
    })),
  }
}

export function isValidDocId(docId) {
  if (typeof docId !== 'string' || docId.length === 0) return false
  if (docId.length > LINK_POLICY.maxDocIdLength) return false
  if (!docIdPattern.test(docId)) return false
  if (docId.endsWith('/') || docId.includes('//') || docId.includes('\\')) return false
  return docId
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..' && !segment.startsWith('_'),
    )
}

/** Repo-relative path of a bundled user doc (`docs/user/<locale>/<docId>.md`). */
export function docSourcePath(docId) {
  return `${LINK_POLICY.docsRoot}/${LINK_POLICY.docsLocale}/${docId}.md`
}

export function docUrlFor(version, docId) {
  const path = LINK_POLICY.docBlobPathTemplate
    .replace('{version}', version)
    .replace('{locale}', LINK_POLICY.docsLocale)
    .replace('{docId}', docId)
  return `${LINK_POLICY.publicRepoBase}${path}`
}

export function isAllowedCommandId(commandId) {
  return LINK_POLICY.allowedCommandIds.includes(commandId)
}

/**
 * Classify a link target. This is the same table the renderer guard uses (see
 * apps/editor/src/shared/releaseNotes/linkPolicy.ts) — both read linkPolicy.json.
 */
export function classifyHref(href) {
  const value = href.trim()
  if (value.length === 0) return { kind: 'invalid', reason: '空链接' }
  if (value.startsWith('#')) {
    return value.length > 1
      ? { kind: 'anchor', anchor: value.slice(1) }
      : { kind: 'invalid', reason: '空锚点' }
  }
  const docPrefix = `${LINK_POLICY.docScheme}:`
  if (value.startsWith(docPrefix)) {
    const docId = value.slice(docPrefix.length)
    return isValidDocId(docId)
      ? { kind: 'doc', docId }
      : { kind: 'invalid', reason: `非法的文档 id：${docId}` }
  }
  const commandPrefix = `${LINK_POLICY.commandScheme}:`
  if (value.startsWith(commandPrefix)) {
    const commandId = value.slice(commandPrefix.length)
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(commandId)) {
      return { kind: 'invalid', reason: `非法的命令 id：${commandId}` }
    }
    return isAllowedCommandId(commandId)
      ? { kind: 'command', commandId }
      : { kind: 'invalid', reason: `命令不在允许清单内：${commandId}` }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  if (scheme !== undefined) {
    if (!LINK_POLICY.allowedExternalSchemes.includes(scheme)) {
      return { kind: 'invalid', reason: `不允许的链接协议：${scheme}:` }
    }
    if (!/^https?:\/\/[^\s]+$/i.test(value))
      return { kind: 'invalid', reason: `非法链接：${value}` }
    return { kind: 'external', url: value }
  }
  return { kind: 'invalid', reason: `相对路径链接不受支持（请用 doc: 指向文档）：${value}` }
}

/** Version header shared by the app card and the static page (never a second copy). */
export function versionHeading(note) {
  return note.date ? `v${note.version} · ${note.date}` : `v${note.version}`
}

/** Where a version's note lives: a root file, or a section of the frozen archive. */
function noteSourceHint(version) {
  return compareVersions(version, LEGACY_MAX_VERSION) <= 0
    ? `docs/release-notes/archive/legacy.md（${version} 分节）`
    : `docs/release-notes/${version}.md`
}

/**
 * Release gate: the target version must have a reviewed (or migrated legacy) note,
 * and its traceability fields must line up with the previous tag.
 */
export function assertReleaseNotesReady({ notes, version, previousTag }) {
  const byVersion = indexNotesByVersion(notes)
  const note = byVersion.get(version)
  if (!note) {
    throw new Error(
      `缺少 ${noteSourceHint(version)}；发版要求先提交 status: reviewed 的正式稿` +
        `（不再从 git 提交列表生成正文）`,
    )
  }
  if (!note.legacy && note.status !== 'reviewed') {
    throw new Error(
      `docs/release-notes/${version}.md 仍是 status: ${note.status}；` +
        `经确认后改为 status: reviewed 再发版`,
    )
  }
  if (!note.legacy && previousTag && note.sourceFrom !== previousTag) {
    throw new Error(
      `docs/release-notes/${version}.md 的 sourceFrom 是 ${note.sourceFrom || '(空)'}，` +
        `期望 ${previousTag}（上一个发布 tag）；请核对整理范围`,
    )
  }
  return note
}
