/*---------------------------------------------------------------------------------------------
 *  Tests for the one-time legacy migration (migrate-legacy.mjs) and for the fidelity of the
 *  archive that is now committed under docs/release-notes/.
 *
 *  The frozen fixture scripts/release/__tests__/fixtures/legacy-release-notes.json is the
 *  pre-migration apps/editor/resources/release-notes.json — that file is now a compiled
 *  artifact, so the fixture is what keeps "the archive still equals what we shipped"
 *  checkable forever. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../../lib/temp-root.mjs'
import {
  LEGACY_MAX_VERSION,
  NOTES_SOURCE_DIR,
  REPO_ROOT,
  parseFrontmatter,
  splitAggregate,
} from '../release-notes/source.mjs'
import { loadNotes } from '../release-notes/compile.mjs'
import {
  LEGACY_ARCHIVE_REL,
  compareArchive,
  contentStructure,
  escapeLegacyText,
  expectedStructure,
  legacyArchiveText,
  legacyBody,
  legacyNoteText,
  migrate,
  planMigration,
  readLegacyJson,
} from '../release-notes/migrate-legacy.mjs'

const FIXTURE = join(REPO_ROOT, 'scripts/release/__tests__/fixtures/legacy-release-notes.json')

/** Archived legacy notes only — root notes for live versions sit beside the archive now. */
const archivedNotes = () => loadNotes().filter((note) => note.file === LEGACY_ARCHIVE_REL)

const entry = (overrides = {}) => ({
  version: '0.1.0',
  date: '2026-01-01',
  groups: [{ type: 'feat', title: '新功能', items: ['一件事'] }],
  ...overrides,
})

test('escapeLegacyText escapes only what the two renderers can un-escape', () => {
  assert.equal(escapeLegacyText('a *b* _c_ [d] e\\f'), 'a \\*b\\* \\_c\\_ \\[d\\] e\\\\f')
  assert.equal(escapeLegacyText('<a id="">'), '\\<a id=""\\>')
  assert.equal(escapeLegacyText('（保留括号）与 ~ 和 &'), '（保留括号）与 ~ 和 &')
})

test('escapeLegacyText leaves code spans untouched', () => {
  assert.equal(escapeLegacyText('`background_activity` 状态'), '`background_activity` 状态')
  assert.equal(escapeLegacyText('（`` `true` ``）'), '（`` `true` ``）')
  assert.equal(escapeLegacyText('`a` 与 _b_'), '`a` 与 \\_b\\_')
})

test('readLegacyJson validates the archived shape', () => {
  const dir = mkTempDir('ue-release-notes-')
  try {
    const path = join(dir, 'notes.json')
    const write = (value) => {
      writeFileSync(path, JSON.stringify(value), 'utf8')
      return () => readLegacyJson(path)
    }
    assert.throws(write({ not: 'an array' }), /顶层必须是数组/)
    assert.throws(write([{ version: '1.0', groups: [] }]), /version 非法/)
    assert.throws(write([entry(), entry()]), /version 0\.1\.0 重复/)
    assert.throws(write([entry({ date: '2026-02-30' })]), /date 非法/)
    assert.throws(
      write([entry({ groups: [{ type: 'docs', title: 'x', items: [] }] })]),
      /type 非法/,
    )
    assert.throws(
      write([entry({ groups: [{ type: 'feat', title: '', items: [] }] })]),
      /title 必须是非空字符串/,
    )
    assert.throws(
      write([entry({ groups: [{ type: 'feat', title: 'x', items: ['a\nb'] }] })]),
      /条目不允许换行/,
    )
    assert.throws(
      write([entry({ groups: [{ type: 'feat', title: 'x', items: [''] }] })]),
      /条目必须是非空字符串/,
    )
    assert.deepEqual(write([entry()])(), [entry()])
    assert.deepEqual(write([entry({ date: undefined })])(), [entry({ date: undefined })])
    assert.throws(
      write([{ version: '0.1.0', body: '## 编译产物\n' }]),
      /这是编译产物（运行时 release-notes\.json，条目带 body 无 groups）/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy notes archive the groups verbatim as headings and list items', () => {
  const text = legacyNoteText(entry())
  assert.equal(
    text,
    [
      '---',
      'version: 0.1.0',
      'date: 2026-01-01',
      'status: reviewed',
      'legacy: true',
      '---',
      '',
      '## 新功能',
      '',
      '- 一件事',
      '',
    ].join('\n'),
  )
  assert.equal(legacyBody(entry({ groups: [] })), '')
  assert.equal(legacyNoteText(entry({ groups: [] })).endsWith('---\n'), true)
  assert.equal(legacyNoteText(entry({ date: undefined })).includes('date:'), false)
})

test('contentStructure reads back what the archive encodes', () => {
  const body = legacyBody(
    entry({
      groups: [
        { type: 'feat', title: '新功能', items: ['`x` 与 \\*y\\*', '第二'] },
        { type: 'fix', title: 'Bug 修复', items: ['一条'] },
      ],
    }),
  )
  assert.deepEqual(
    contentStructure(body),
    expectedStructure(
      entry({
        groups: [
          { type: 'feat', title: '新功能', items: ['`x` 与 \\*y\\*', '第二'] },
          { type: 'fix', title: 'Bug 修复', items: ['一条'] },
        ],
      }),
    ),
  )
})

test('migrate folds the split notes into one archive and deletes them', () => {
  const dir = mkTempDir('ue-release-notes-')
  try {
    const notesDir = join(dir, 'notes')
    const entries = [entry(), entry({ version: '0.1.1', date: undefined })]
    const first = migrate({ entries, notesDir })
    assert.equal(first.written, true)
    assert.equal(first.skipped, false)
    assert.deepEqual(first.removed, [])
    const archive = join(notesDir, ...LEGACY_ARCHIVE_REL.split('/'))
    assert.equal(readFileSync(archive, 'utf8'), legacyArchiveText(entries))
    assert.deepEqual(compareArchive({ entries, notesDir }), [])

    // A second run finds the archive exact: nothing rewritten, nothing removed.
    const second = migrate({ entries, notesDir })
    assert.equal(second.skipped, true)
    assert.equal(readFileSync(archive, 'utf8'), legacyArchiveText(entries))

    // A hand-edited split file is never deleted silently.
    writeFileSync(join(notesDir, '0.1.0.md'), '手改过\n', 'utf8')
    assert.throws(() => migrate({ entries, notesDir }), /拒绝迁移：0\.1\.0\.md/)
    assert.equal(readFileSync(join(notesDir, '0.1.0.md'), 'utf8'), '手改过\n')
    writeFileSync(join(notesDir, '0.1.0.md'), legacyNoteText(entries[0]), 'utf8')

    // An archive that drifted from the JSON blocks the run unless forced.
    writeFileSync(archive, '改坏了\n', 'utf8')
    assert.throws(() => migrate({ entries, notesDir }), /已存在且与旧 JSON 不一致/)
    assert.deepEqual(planMigration({ entries, notesDir }).splitFiles, ['0.1.0.md'])
    const forced = migrate({ entries, notesDir, force: true })
    assert.equal(forced.written, true)
    assert.deepEqual(forced.removed, ['0.1.0.md'])
    assert.equal(readFileSync(archive, 'utf8'), legacyArchiveText(entries))
    assert.ok(!existsSync(join(notesDir, '0.1.0.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrate --dry-run reports without touching the disk', () => {
  const dir = mkTempDir('ue-release-notes-')
  try {
    const notesDir = join(dir, 'notes')
    mkdirSync(notesDir, { recursive: true })
    const entries = [entry()]
    writeFileSync(join(notesDir, '0.1.0.md'), legacyNoteText(entries[0]), 'utf8')
    const result = migrate({ entries, notesDir, dryRun: true })
    assert.equal(result.written, true)
    assert.deepEqual(result.removed, ['0.1.0.md'])
    assert.ok(!existsSync(join(notesDir, ...LEGACY_ARCHIVE_REL.split('/'))))
    assert.ok(existsSync(join(notesDir, '0.1.0.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('compareArchive names the drifted sections and the leftover split files', () => {
  const dir = mkTempDir('ue-release-notes-')
  try {
    const notesDir = join(dir, 'notes')
    const entries = [entry(), entry({ version: '0.1.1', date: undefined })]
    migrate({ entries, notesDir })
    const archive = join(notesDir, ...LEGACY_ARCHIVE_REL.split('/'))

    // A half-finished migration: the archive is fine, the split file is still there.
    writeFileSync(join(notesDir, '0.1.0.md'), legacyNoteText(entries[0]), 'utf8')
    assert.deepEqual(compareArchive({ entries, notesDir }), [
      '仍存在旧的 0.1.0.md 分文件（迁移未完成）',
    ])
    rmSync(join(notesDir, '0.1.0.md'))

    writeFileSync(archive, legacyArchiveText(entries).replace('- 一件事', '- 改过'), 'utf8')
    assert.deepEqual(compareArchive({ entries, notesDir }), [
      'archive/legacy.md（0.1.0 分节）与旧 JSON 的归档文本不一致',
    ])

    writeFileSync(archive, legacyArchiveText([entries[1]]), 'utf8')
    assert.deepEqual(compareArchive({ entries, notesDir }), ['archive/legacy.md 缺少 0.1.0 分节'])

    writeFileSync(archive, legacyArchiveText([...entries, entry({ version: '0.1.2' })]), 'utf8')
    assert.deepEqual(compareArchive({ entries, notesDir }), [
      'archive/legacy.md 多出旧 JSON 中没有的 0.1.2 分节',
    ])

    writeFileSync(archive, '前言\n', 'utf8')
    assert.match(compareArchive({ entries, notesDir })[0], /^archive\/legacy\.md 无法解析：/)

    rmSync(archive)
    assert.deepEqual(compareArchive({ entries, notesDir }), ['缺少归档 archive/legacy.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the committed archive is still byte-equal to the pre-migration JSON', () => {
  const entries = readLegacyJson(FIXTURE)
  assert.equal(entries.length, 88)
  assert.equal(entries[0].version, LEGACY_MAX_VERSION)
  const archive = readFileSync(join(NOTES_SOURCE_DIR, ...LEGACY_ARCHIVE_REL.split('/')), 'utf8')
  assert.equal(archive, legacyArchiveText(entries))
  assert.deepEqual(
    splitAggregate(archive, { label: LEGACY_ARCHIVE_REL }).map((section) => section.version),
    entries.map((item) => item.version),
  )
  assert.deepEqual(compareArchive({ entries, notesDir: NOTES_SOURCE_DIR }), [])
})

test('every archived note is legacy, reviewed, and compiles as-is', () => {
  const notes = archivedNotes()
  assert.equal(notes.length, 88)
  assert.ok(notes.every((note) => note.legacy && note.status === 'reviewed'))
  assert.ok(notes.every((note) => !('title' in note) || note.title === ''))
  assert.ok(notes.every((note) => existsSync(join(NOTES_SOURCE_DIR, note.file))))
  assert.ok(notes.every((note) => note.body === '' || contentStructure(note.body).length > 0))
  assert.ok(notes.some((note) => note.body === ''))
})

test('the archive keeps the exact item count of the pre-migration JSON', () => {
  const entries = readLegacyJson(FIXTURE)
  const expectedItems = entries.reduce(
    (sum, item) => sum + item.groups.reduce((groupSum, group) => groupSum + group.items.length, 0),
    0,
  )
  const actualItems = archivedNotes().reduce(
    (sum, note) => sum + contentStructure(note.body).filter((node) => node.kind === 'item').length,
    0,
  )
  assert.equal(actualItems, expectedItems)
  assert.ok(expectedItems > 500, `归档条目数应覆盖全部历史：${expectedItems}`)
})

test('an archived file parses back into the same fields and body', () => {
  const { fields, body } = parseFrontmatter(legacyNoteText(entry()), '0.1.0.md')
  assert.equal(fields.get('legacy'), 'true')
  assert.equal(fields.get('status'), 'reviewed')
  assert.equal(body.startsWith('## 新功能'), true)
})
