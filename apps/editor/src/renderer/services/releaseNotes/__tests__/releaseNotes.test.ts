/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the pure release-notes helpers: version comparison, range selection, and
 *  the version ceiling the running install may show.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  notesUpToVersion,
  selectNotesInRange,
  splitNoteBodySections,
} from '../releaseNotes.js'
import type { IReleaseNote } from '../../../../shared/ipc/releaseNotesService.js'
import mergedRuntime from '../../../../shared/releaseNotes/__tests__/fixtures/mergedRuntimeEntries.json'

const note = (version: string, date?: string): IReleaseNote => ({
  version,
  ...(date !== undefined ? { date } : {}),
  title: '',
  summary: '',
  body: `## ${version}\n\n- 条目\n`,
})

const notes: IReleaseNote[] = [
  note('0.1.3', '2026-06-02'),
  note('0.1.2', '2026-05-20'),
  note('0.1.1', '2026-05-01'),
]

describe('compareVersions', () => {
  it('orders by numeric segments', () => {
    expect(compareVersions('0.1.2', '0.1.1')).toBeGreaterThan(0)
    expect(compareVersions('0.1.1', '0.1.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0)
  })

  it('tolerates a leading v and pre-release suffix', () => {
    expect(compareVersions('v0.1.2', '0.1.2')).toBe(0)
    expect(compareVersions('0.1.2-beta.1', '0.1.2')).toBe(0)
  })
})

describe('selectNotesInRange', () => {
  it('returns versions in (from, to]', () => {
    const picked = selectNotesInRange(notes, '0.1.1', '0.1.3').map((n) => n.version)
    expect(picked).toEqual(['0.1.3', '0.1.2'])
  })

  it('excludes the from version and includes the to version', () => {
    const picked = selectNotesInRange(notes, '0.1.2', '0.1.3').map((n) => n.version)
    expect(picked).toEqual(['0.1.3'])
  })

  it('is empty when nothing is newer than from', () => {
    expect(selectNotesInRange(notes, '0.1.3', '0.1.3')).toEqual([])
  })
})

describe('notesUpToVersion', () => {
  it('drops versions the running app has never been', () => {
    const picked = notesUpToVersion([note('0.2.0'), ...notes], '0.1.3')
    expect(picked.map((n) => n.version)).toEqual(['0.1.3', '0.1.2', '0.1.1'])
  })

  it('keeps a versionless entry (a tab restored from pre-schema-2 state)', () => {
    const legacy = note('')
    expect(notesUpToVersion([legacy], '0.1.3')).toEqual([legacy])
  })
})

describe('splitNoteBodySections', () => {
  it('leaves a body with no metadata as one section at the note version', () => {
    const body = '## 本次重点\n\n- 主稿内容\n'
    expect(splitNoteBodySections(body, '0.15.1')).toEqual([{ version: '0.15.1', markdown: body }])
  })

  it('splits a merged body by the compiler’s character offsets', () => {
    const merged = (mergedRuntime as unknown as IReleaseNote[])[0]!
    const sections = splitNoteBodySections(merged.body, merged.version, merged.bodySections)
    expect(sections.map((s) => s.version)).toEqual(['0.15.1', '0.15.2', '0.15.3'])
    // 重新拼回原正文，一段不多一段不少。
    expect(sections.map((s) => s.markdown).join('')).toBe(merged.body)
    expect(sections[0]?.markdown).toContain('本次重点')
    expect(sections[0]?.markdown).not.toContain('补丁修复')
    // 补丁段带上自己的标题；代码块里的假标题（## v9.9.9）只是段内文本，没有多切一段。
    expect(sections).toHaveLength(3)
    expect(sections[1]?.markdown).toMatch(/^## v0\.15\.2 补丁修复/)
    expect(sections[1]?.markdown).toContain('## v9.9.9 补丁修复')
  })

  it('splits by offset even when the boundary heading wording differs', () => {
    const body = '## 主稿\n\n---\n\n## 任意文案\n\n- 补丁\n'
    const offset = body.indexOf('## 任意文案')
    const sections = splitNoteBodySections(body, '0.15.1', [
      { version: '0.15.1', offset: 0 },
      { version: '0.15.2', offset },
    ])
    expect(sections.map((s) => s.version)).toEqual(['0.15.1', '0.15.2'])
    expect(sections[1]?.markdown.startsWith('## 任意文案')).toBe(true)
  })

  it('falls back to one section when the metadata is untrustworthy', () => {
    const body = '## 本次重点\n\n- 主稿内容\n'
    // 偏移越界 / 首段版本不符 / 未递增：一律整篇单段，绝不错切。
    expect(splitNoteBodySections(body, '0.15.1', [{ version: '0.15.1', offset: 999 }])).toEqual([
      { version: '0.15.1', markdown: body },
    ])
    expect(
      splitNoteBodySections(body, '0.15.1', [
        { version: '0.15.2', offset: 0 },
        { version: '0.15.3', offset: 5 },
      ]),
    ).toEqual([{ version: '0.15.1', markdown: body }])
    expect(
      splitNoteBodySections(body, '0.15.1', [
        { version: '0.15.1', offset: 0 },
        { version: '0.15.0', offset: 5 },
      ]),
    ).toEqual([{ version: '0.15.1', markdown: body }])
  })

  it('returns one section for an empty body', () => {
    expect(splitNoteBodySections('', '0.15.1')).toEqual([{ version: '0.15.1', markdown: '' }])
  })
})
