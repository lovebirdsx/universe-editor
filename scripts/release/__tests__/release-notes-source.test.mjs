/*---------------------------------------------------------------------------------------------
 *  Tests for the release-notes source layer (scripts/release/release-notes/source.mjs).
 *  Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LEGACY_MAX_VERSION,
  LINK_POLICY,
  REPO_ROOT,
  assertReleaseNotesReady,
  buildRuntimeEntries,
  buildSiteIndex,
  classifyHref,
  compareVersions,
  docSourcePath,
  docUrlFor,
  indexNotesByVersion,
  isAllowedCommandId,
  isNoteFileName,
  isValidDate,
  isValidDocId,
  isValidVersion,
  legacySectionMarker,
  parseFrontmatter,
  parseNote,
  selectReleasableNotes,
  serializeRuntimeJson,
  sortNotesNewestFirst,
  splitAggregate,
  versionHeading,
} from '../release-notes/source.mjs'
import { slugifyHeading } from '../release-notes/markdown.mjs'

/** `null` omits a frontmatter line entirely (unlike `undefined`, which JS defaults away). */
function noteText(
  { version = '0.15.0', date = '2026-10-01', ...fields } = {},
  body = '## 本次重点\n\n- 一条\n',
) {
  const lines = ['---']
  if (version !== null) lines.push(`version: ${version}`)
  if (date !== null) lines.push(`date: ${date}`)
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) lines.push(`${key}: ${value}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}\n${body}`
}

/** `file` follows the production convention: a path relative to docs/release-notes. */
function noteFile(version = '0.15.0') {
  return { file: `${version}.md` }
}

function reviewed(overrides = {}, body) {
  const version = overrides.version ?? '0.15.0'
  return parseNote(
    noteText(
      {
        title: '好用的版本',
        summary: '一句话摘要。',
        status: 'reviewed',
        sourceFrom: 'v0.14.9',
        sourceTo: 'a'.repeat(40),
        ...overrides,
      },
      body,
    ),
    noteFile(version),
  )
}

test('parseFrontmatter splits flat fields from the body and normalizes CRLF', () => {
  const { fields, body } = parseFrontmatter(
    '---\r\nversion: 0.15.0\r\ntitle: "带 引号"\r\n\r\nstatus: draft\r\n---\r\n\r\n## 小节\r\n\r\n内容\r\n',
    'x.md',
  )
  assert.equal(fields.get('version'), '0.15.0')
  assert.equal(fields.get('title'), '带 引号')
  assert.equal(fields.get('status'), 'draft')
  assert.equal(body, '## 小节\n\n内容\n')
  assert.ok(!body.includes('\r'))
})

test('parseFrontmatter rejects missing/unclosed fences, nesting and bad lines', () => {
  assert.throws(() => parseFrontmatter('version: 1\n', 'x.md'), /frontmatter 缺失/)
  assert.throws(() => parseFrontmatter('---\nversion: 1\n', 'x.md'), /frontmatter 未闭合/)
  assert.throws(() => parseFrontmatter('---\n  nested: 1\n---\n', 'x.md'), /不支持缩进/)
  assert.throws(() => parseFrontmatter('---\njust a line\n---\n', 'x.md'), /必须是 `key: value`/)
  assert.throws(
    () => parseFrontmatter('---\nversion: 1\nversion: 2\n---\n', 'x.md'),
    /字段 version 重复/,
  )
})

test('parseFrontmatter lifts line numbers and the body start by lineOffset', () => {
  const text = '---\nversion: 0.1.3\n---\n\n## 新功能\n'
  assert.equal(parseFrontmatter(text, 'x.md').bodyLine, 5)
  assert.equal(parseFrontmatter(text, 'x.md', { lineOffset: 10 }).bodyLine, 15)
  assert.throws(
    () => parseFrontmatter('---\n  nested: 1\n---\n', 'x.md', { lineOffset: 10 }),
    /第 12 行：frontmatter 不支持缩进/,
  )
})

test('parseNote requires version, filename agreement and a known status', () => {
  assert.throws(() => parseNote(noteText({ version: null }), noteFile()), /缺少必填字段 version/)
  assert.throws(
    () => parseNote(noteText({ version: '0.15' }), noteFile('0.15')),
    /version 必须是 X\.Y\.Z/,
  )
  assert.throws(
    () => parseNote(noteText(), noteFile('0.14.0')),
    /文件名 0\.14\.0\.md 与 frontmatter version 0\.15\.0 不一致/,
  )
  assert.throws(
    () => parseNote(noteText({ status: 'published' }), noteFile()),
    /status 必须是 draft \| reviewed/,
  )
  assert.throws(
    () => parseNote(noteText({ status: 'draft', extra: 'x' }), noteFile()),
    /未知字段 extra/,
  )
})

test('parseNote checks an archive section marker instead of the file name', () => {
  const text = noteText(
    { version: '0.1.3', date: null, legacy: 'true', status: 'reviewed' },
    '## 新功能\n\n- 归档\n',
  )
  const note = parseNote(text, { file: 'archive/legacy.md', expectedVersion: '0.1.3' })
  assert.equal(note.file, 'archive/legacy.md')
  assert.equal(note.label, 'archive/legacy.md（0.1.3 分节）')
  assert.equal(note.legacy, true)
  assert.throws(
    () => parseNote(text, { file: 'archive/legacy.md', expectedVersion: '0.1.4' }),
    /archive\/legacy\.md（0\.1\.4 分节）: 分节标记 version 0\.1\.4 与 frontmatter version 0\.1\.3 不一致/,
  )
})

test('parseNote validates dates without inventing them', () => {
  assert.throws(
    () => parseNote(noteText({ date: null, status: 'draft' }), noteFile()),
    /缺少必填字段 date/,
  )
  assert.throws(
    () => parseNote(noteText({ date: '2026-02-30', status: 'draft' }), noteFile()),
    /date 必须是合法 YYYY-MM-DD/,
  )
  assert.equal(isValidDate('2024-02-29'), true)
  assert.equal(isValidDate('2026-02-29'), false)
  assert.equal(isValidDate('2026-13-01'), false)
  assert.equal(isValidDate('2026-1-1'), false)
})

test('reviewed notes must carry title, summary, traceability and a body', () => {
  assert.throws(() => reviewed({ title: null }), /必须有 title/)
  assert.throws(() => reviewed({ summary: null }), /必须有 summary/)
  assert.throws(() => reviewed({}, ''), /不能是空正文/)
  assert.throws(
    () => reviewed({ sourceFrom: null, sourceTo: null }),
    /必须记录 sourceFrom \/ sourceTo/,
  )
  assert.throws(() => reviewed({ sourceFrom: '0.14.9' }), /sourceFrom 必须是 tag 形式/)
  assert.throws(() => reviewed({ sourceTo: 'HEAD' }), /sourceTo 必须是提交 SHA/)
  assert.throws(() => reviewed({}, '# 一级标题\n'), /不要写一级标题/)
})

test('an H1 inside a fenced code block is not a heading', () => {
  const note = reviewed({}, '## 示例\n\n```bash\n# 注释\n```\n')
  assert.match(note.body, /# 注释/)
})

test('drafts still need a date, but may omit title and summary', () => {
  const note = parseNote(noteText({ status: 'draft', title: null, summary: null }), noteFile())
  assert.equal(note.status, 'draft')
  assert.equal(note.date, '2026-10-01')
  assert.equal(note.title, '')
  assert.equal(note.summary, '')
  assert.throws(
    () => parseNote(noteText({ status: 'draft', date: null }), noteFile()),
    /缺少必填字段 date/,
  )
})

test('legacy is limited to the migration ceiling and must be reviewed', () => {
  const legacy = parseNote(
    noteText(
      { version: LEGACY_MAX_VERSION, legacy: 'true', status: 'reviewed', date: null },
      '## 新功能\n\n- 归档条目\n',
    ),
    noteFile(LEGACY_MAX_VERSION),
  )
  assert.equal(legacy.legacy, true)
  assert.equal(legacy.date, undefined)

  assert.throws(
    () => parseNote(noteText({ legacy: 'true', status: 'reviewed' }, '## x\n'), noteFile()),
    /legacy 仅用于迁移归档/,
  )
  assert.throws(
    () =>
      parseNote(
        noteText({ version: LEGACY_MAX_VERSION, legacy: 'yes', status: 'reviewed' }, '## x\n'),
        noteFile(LEGACY_MAX_VERSION),
      ),
    /legacy 只接受 `true`/,
  )
  assert.throws(
    () =>
      parseNote(
        noteText({ version: LEGACY_MAX_VERSION, legacy: 'true', status: 'draft' }, '## x\n'),
        noteFile(LEGACY_MAX_VERSION),
      ),
    /legacy 归档必须标记 status: reviewed/,
  )
})

test('an empty body stays empty (never a lone newline)', () => {
  const { body } = parseFrontmatter('---\nversion: 0.1.3\n---\n', 'x.md')
  assert.equal(body, '')
  const note = parseNote(
    noteText({ version: '0.1.3', date: null, legacy: 'true', status: 'reviewed' }, ''),
    noteFile('0.1.3'),
  )
  assert.equal(note.body, '')
  assert.deepEqual(buildRuntimeEntries([note])[0].body, '')
})

test('splitAggregate round-trips sections byte for byte with absolute line numbers', () => {
  const empty = noteText({ version: '0.2.0', date: null, legacy: 'true', status: 'reviewed' }, '')
  const full = noteText(
    { version: '0.1.3', date: null, legacy: 'true', status: 'reviewed' },
    '## 新功能\n\n- 归档\n',
  )
  const source = `${legacySectionMarker('0.2.0')}\n${empty}\n${legacySectionMarker('0.1.3')}\n${full}`
  const sections = splitAggregate(source, { label: 'archive/legacy.md' })
  assert.deepEqual(
    sections.map((section) => section.version),
    ['0.2.0', '0.1.3'],
  )
  assert.equal(sections[0].text, empty)
  assert.equal(sections[1].text, full)
  assert.equal(sections[0].lineOffset, 1)
  assert.equal(sections[1].lineOffset, empty.split('\n').length + 2)
})

test('splitAggregate fails loud on malformed archives', () => {
  const label = 'archive/legacy.md'
  const text = noteText({ version: '0.1.3', date: null, legacy: 'true', status: 'reviewed' }, '')
  const section = `${legacySectionMarker('0.1.3')}\n${text}`
  assert.throws(() => splitAggregate('', { label }), /没有任何分节标记/)
  assert.throws(() => splitAggregate('\n前言\n', { label }), /必须以分节标记开头/)
  assert.throws(() => splitAggregate('<!--release-note: 0.1.3-->\n', { label }), /分节标记格式非法/)
  assert.throws(
    () => splitAggregate(`${section}\n${section}`, { label }),
    /第 9 行：版本 0\.1\.3 重复（第 1 行已出现）/,
  )
  assert.throws(
    () => splitAggregate(`${section}\n\`\`\`\n${legacySectionMarker('0.1.2')}\n\`\`\`\n`, { label }),
    /分节标记出现在 fenced code block 内/,
  )
})

test('splitAggregate normalizes CRLF before splitting', () => {
  const text = noteText({ version: '0.1.3', date: null, legacy: 'true', status: 'reviewed' }, '')
  const crlf = `${legacySectionMarker('0.1.3')}\n${text}`.replace(/\n/g, '\r\n')
  const [first] = splitAggregate(crlf, { label: 'archive/legacy.md' })
  assert.equal(first.text, text)
  assert.ok(!first.text.includes('\r'))
})

test('note file names: version notes only', () => {
  assert.equal(isNoteFileName('0.15.0.md'), true)
  assert.equal(isNoteFileName('README.md'), false)
  assert.equal(isNoteFileName('readme.md'), false)
  assert.equal(isNoteFileName('_template.md'), false)
  assert.equal(isNoteFileName('notes.txt'), false)
  assert.equal(isValidVersion('0.15.0'), true)
  assert.equal(isValidVersion('v0.15.0'), false)
})

test('versions sort numerically, newest first (0.10.0 above 0.9.0)', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0)
  assert.equal(compareVersions('0.14.9', '0.14.9'), 0)
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
  const sorted = sortNotesNewestFirst([
    { version: '0.9.0' },
    { version: '0.10.0' },
    { version: '0.14.9' },
  ])
  assert.deepEqual(
    sorted.map((note) => note.version),
    ['0.14.9', '0.10.0', '0.9.0'],
  )
})

test('duplicate versions are rejected listing both files', () => {
  assert.throws(
    () =>
      indexNotesByVersion([
        { version: '0.15.0', file: 'a.md' },
        { version: '0.15.0', file: 'b.md' },
      ]),
    /0\.15\.0 有多份正文：a\.md 与 b\.md/,
  )
})

test('only reviewed (or migrated legacy) notes at or below the bound are released', () => {
  const draft = { version: '0.16.0', status: 'draft', legacy: false }
  const reviewedNote = { version: '0.15.0', status: 'reviewed', legacy: false }
  const legacyNote = { version: '0.14.9', status: 'reviewed', legacy: true }
  const future = { version: '0.17.0', status: 'reviewed', legacy: false }
  const selected = selectReleasableNotes([draft, reviewedNote, legacyNote, future], '0.15.0')
  assert.deepEqual(
    selected.map((note) => note.version),
    ['0.15.0', '0.14.9'],
  )
  assert.equal(selectReleasableNotes([draft], undefined).length, 0)
})

test('release gate guidance names the missing file and the draft state', () => {
  const draft = {
    version: '0.15.0',
    status: 'draft',
    legacy: false,
    file: '0.15.0.md',
    sourceFrom: 'v0.14.9',
  }
  assert.throws(
    () => assertReleaseNotesReady({ notes: [draft], version: '0.16.0' }),
    /缺少 docs\/release-notes\/0\.16\.0\.md/,
  )
  assert.throws(
    () => assertReleaseNotesReady({ notes: [draft], version: '0.15.0' }),
    /仍是 status: draft；经确认后改为 status: reviewed/,
  )
  const ready = { ...draft, status: 'reviewed' }
  assert.equal(
    assertReleaseNotesReady({ notes: [ready], version: '0.15.0', previousTag: 'v0.14.9' }).version,
    '0.15.0',
  )
  assert.throws(
    () =>
      assertReleaseNotesReady({
        notes: [{ ...ready, sourceFrom: 'v0.14.8' }],
        version: '0.15.0',
        previousTag: 'v0.14.9',
      }),
    /sourceFrom 是 v0\.14\.8，期望 v0\.14\.9/,
  )
})

test('legacy notes pass the review gate', () => {
  const legacyNote = { version: '0.14.9', status: 'reviewed', legacy: true, file: '0.14.9.md' }
  assert.equal(assertReleaseNotesReady({ notes: [legacyNote], version: '0.14.9' }).legacy, true)
  assert.throws(
    () => assertReleaseNotesReady({ notes: [], version: '0.14.9' }),
    /缺少 docs\/release-notes\/archive\/legacy\.md（0\.14\.9 分节）/,
  )
})

test('runtime entries keep a fixed key order and drop an absent date', () => {
  const notes = [
    reviewed(),
    parseNote(
      noteText(
        { version: '0.14.9', date: null, legacy: 'true', status: 'reviewed' },
        '## 新功能\n\n- 归档\n',
      ),
      noteFile('0.14.9'),
    ),
  ]
  const entries = buildRuntimeEntries(notes)
  assert.deepEqual(Object.keys(entries[0]), ['version', 'date', 'title', 'summary', 'body'])
  assert.deepEqual(Object.keys(entries[1]), ['version', 'title', 'summary', 'body'])
  assert.equal(entries[0].body, '## 本次重点\n\n- 一条\n')
  assert.deepEqual(entries[0], {
    version: '0.15.0',
    date: '2026-10-01',
    title: '好用的版本',
    summary: '一句话摘要。',
    body: '## 本次重点\n\n- 一条\n',
  })

  const json = serializeRuntimeJson(notes)
  assert.equal(json, `${JSON.stringify(entries, null, 2)}\n`)
  assert.ok(json.endsWith(']\n') && json.startsWith('[\n  {\n    "version": "0.15.0",'))
  assert.equal(serializeRuntimeJson(notes), json)
})

test('site index carries metadata and page paths, never bodies', () => {
  const index = buildSiteIndex([reviewed()])
  assert.deepEqual(Object.keys(index.versions[0]), ['version', 'date', 'title', 'summary', 'path'])
  assert.equal(index.versions[0].path, 'v0.15.0.html')
  assert.equal(index.schema, 1)
  assert.ok(!JSON.stringify(index).includes('本次重点'))
})

test('version heading is shared by the app card and the static page', () => {
  assert.equal(versionHeading({ version: '0.15.0', date: '2026-10-01' }), 'v0.15.0 · 2026-10-01')
  assert.equal(versionHeading({ version: '0.1.3' }), 'v0.1.3')
})

test('docId and doc URLs are locale-relative and never escape docs/user', () => {
  assert.equal(isValidDocId('getting-started/interface-tour'), true)
  assert.equal(isValidDocId('a'), true)
  assert.equal(isValidDocId(''), false)
  assert.equal(isValidDocId('a'.repeat(LINK_POLICY.maxDocIdLength + 1)), false)
  assert.equal(isValidDocId('/abs/path'), false)
  assert.equal(isValidDocId('../escape'), false)
  assert.equal(isValidDocId('a/./b'), false)
  assert.equal(isValidDocId('a/_private'), false)
  assert.equal(isValidDocId('a\\b'), false)
  assert.equal(isValidDocId('a//b'), false)
  assert.equal(isValidDocId('a/'), false)
  assert.equal(isValidDocId('文档/介绍'), false)
  assert.equal(
    docSourcePath('getting-started/interface-tour'),
    'docs/user/zh-CN/getting-started/interface-tour.md',
  )
  assert.equal(
    docUrlFor('0.15.0', 'getting-started/interface-tour'),
    `${LINK_POLICY.publicRepoBase}/blob/v0.15.0/docs/user/zh-CN/getting-started/interface-tour.md`,
  )
})

test('command allowlist is explicit', () => {
  assert.equal(isAllowedCommandId('workbench.action.openSettings'), true)
  assert.equal(isAllowedCommandId('workbench.action.terminal.new'), false)
})

test('classifyHref matches the shared fixtures (same table as the renderer guard)', () => {
  const fixturePath = join(
    REPO_ROOT,
    'apps/editor/src/shared/releaseNotes/__tests__/fixtures/linkHrefCases.json',
  )
  const { cases } = JSON.parse(readFileSync(fixturePath, 'utf8'))
  assert.ok(cases.length > 20, '夹具应覆盖足够多的链接形态')
  for (const { href, expect } of cases) {
    assert.deepEqual(classifyHref(href), expect, `classifyHref(${JSON.stringify(href)})`)
  }
  const kinds = new Set(cases.map((entry) => entry.expect.kind))
  for (const kind of ['anchor', 'doc', 'command', 'external', 'invalid']) {
    assert.ok(kinds.has(kind), `夹具缺少 ${kind} 形态`)
  }
})

test('slugifyHeading matches the shared fixtures (same table as the app renderer)', () => {
  const fixturePath = join(
    REPO_ROOT,
    'apps/editor/src/shared/releaseNotes/__tests__/fixtures/headingSlugCases.json',
  )
  const { cases } = JSON.parse(readFileSync(fixturePath, 'utf8'))
  assert.ok(cases.length > 5, '夹具应覆盖足够多的标题形态')
  for (const { text, slug } of cases) {
    assert.equal(slugifyHeading(text), slug, `slugifyHeading(${JSON.stringify(text)})`)
  }
})

test('the public repo base is the one the packages declare', () => {
  const declared = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/primitives/package.json'), 'utf8'),
  )
    .repository.url.replace(/^git\+/, '')
    .replace(/\.git$/, '')
  assert.equal(LINK_POLICY.publicRepoBase, declared)
  assert.equal(LINK_POLICY.schema, 1)
  assert.deepEqual(Object.keys(LINK_POLICY).sort(), [
    'allowedCommandIds',
    'allowedExternalSchemes',
    'commandScheme',
    'docBlobPathTemplate',
    'docIdPattern',
    'docScheme',
    'docsLocale',
    'docsRoot',
    'maxDocIdLength',
    'publicRepoBase',
    'schema',
  ])
  assert.deepEqual(LINK_POLICY.allowedExternalSchemes, ['http', 'https'])
})
