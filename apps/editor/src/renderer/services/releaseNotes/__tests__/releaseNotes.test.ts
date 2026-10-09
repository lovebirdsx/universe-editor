/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the pure release-notes helpers: version comparison, range selection, and
 *  the version ceiling the running install may show.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { compareVersions, notesUpToVersion, selectNotesInRange } from '../releaseNotes.js'
import type { IReleaseNote } from '../../../../shared/ipc/releaseNotesService.js'

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
