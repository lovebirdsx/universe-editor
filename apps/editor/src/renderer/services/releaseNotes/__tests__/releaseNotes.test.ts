/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the pure release-notes helpers: version comparison, range selection,
 *  and markdown rendering.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { compareVersions, renderReleaseNotesMarkdown, selectNotesInRange } from '../releaseNotes.js'
import type { IReleaseNote } from '../../../../shared/ipc/releaseNotesService.js'

const notes: IReleaseNote[] = [
  {
    version: '0.1.3',
    date: '2026-06-02',
    groups: [{ type: 'feat', title: '新功能', items: ['C'] }],
  },
  {
    version: '0.1.2',
    date: '2026-05-20',
    groups: [{ type: 'fix', title: 'Bug 修复', items: ['B'] }],
  },
  {
    version: '0.1.1',
    date: '2026-05-01',
    groups: [{ type: 'feat', title: '新功能', items: ['A'] }],
  },
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

describe('renderReleaseNotesMarkdown', () => {
  it('renders headings, group titles, and bullet lists', () => {
    const md = renderReleaseNotesMarkdown([notes[1]!])
    expect(md).toContain('## 0.1.2 (2026-05-20)')
    expect(md).toContain('### Bug 修复')
    expect(md).toContain('- B')
  })

  it('omits the date when absent and skips empty groups', () => {
    const md = renderReleaseNotesMarkdown([
      { version: '9.9.9', groups: [{ type: 'feat', title: '新功能', items: [] }] },
    ])
    expect(md).toContain('## 9.9.9')
    expect(md).not.toContain('(')
    expect(md).not.toContain('### 新功能')
  })
})
