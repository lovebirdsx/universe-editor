/*---------------------------------------------------------------------------------------------
 *  Tests for ReleaseNotesMainService: the compiled release-notes.json is machine-produced
 *  but shipped inside the installer, so main validates it per field and degrades instead
 *  of crashing the tab.
 *--------------------------------------------------------------------------------------------*/

import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { ILogger } from '@universe-editor/platform'

declare const __APP_VERSION__: string

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const warnings: string[] = []

const { ReleaseNotesMainService, parseReleaseNotes } = await import('../releaseNotesMainService.js')

function serviceFor(file: string): InstanceType<typeof ReleaseNotesMainService> {
  const logger = { warn: (message: string) => warnings.push(message) } as unknown as ILogger
  return new ReleaseNotesMainService(() => file, { createLogger: () => logger } as never)
}

const note = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  date: '2026-10-01',
  title: '标题',
  summary: '摘要',
  body: '## 小节\n\n- 一条\n',
  ...extra,
})

describe('parseReleaseNotes', () => {
  it('accepts well-formed entries and keeps the file order', () => {
    const { notes, problems } = parseReleaseNotes([
      note('0.15.0'),
      { version: '0.14.9', title: '', summary: '', body: '' },
    ])
    expect(problems).toEqual([])
    expect(notes.map((entry) => entry.version)).toEqual(['0.15.0', '0.14.9'])
    expect(notes[0]).toEqual(note('0.15.0'))
    expect(notes[1]).toEqual({ version: '0.14.9', title: '', summary: '', body: '' })
  })

  it('rejects a non-array payload', () => {
    expect(parseReleaseNotes({ notes: [] })).toEqual({ notes: [], problems: ['顶层不是数组'] })
    expect(parseReleaseNotes(null).notes).toEqual([])
  })

  it('drops only the entries that cannot be rendered', () => {
    const { notes, problems } = parseReleaseNotes([
      'not-an-object',
      { version: 'v0.15.0', title: '', summary: '', body: '' },
      { version: '0.15.0', title: 'ok', summary: '', body: '' },
      { version: '0.15.0', title: 'dup', summary: '', body: '' },
      { version: '0.14.0', title: 42, summary: '', body: '' },
      { version: '0.13.0', title: '', summary: '', body: null },
      // Shape only: main displays the date, the compiler is what validates the calendar.
      { version: '0.12.0', date: '2026/10/01', title: '', summary: '', body: '' },
    ])
    expect(notes.map((entry) => entry.version)).toEqual(['0.15.0', '0.12.0'])
    expect(notes[1]?.date).toBeUndefined()
    expect(problems).toHaveLength(6)
    const log = problems.join(' | ')
    expect(log).toContain('不是对象')
    expect(log).toContain('version 非法')
    expect(log).toContain('version 0.15.0 重复')
    expect(log).toContain('title 不是字符串')
    expect(log).toContain('body 不是字符串')
    expect(log).toContain('date 非法')
  })
})

describe('ReleaseNotesMainService', () => {
  let dir: string

  beforeEach(() => {
    warnings.length = 0
    dir = mkTempDir('ue-release-notes-svc-')
    return () => rmSync(dir, { recursive: true, force: true })
  })

  it('reads the compiled entries and caches the file', async () => {
    const file = join(dir, 'release-notes.json')
    writeFileSync(file, JSON.stringify([note('0.15.0')]), 'utf8')
    const service = serviceFor(file)
    const first = await service.getReleaseNotes()
    expect(first.currentVersion).toBe(__APP_VERSION__)
    expect(first.notes).toHaveLength(1)

    writeFileSync(file, JSON.stringify([]), 'utf8')
    expect((await service.getReleaseNotes()).notes).toHaveLength(1)
  })

  it('keeps the good entries and logs a bounded diagnostic', async () => {
    const file = join(dir, 'release-notes.json')
    const entries = [note('0.15.0'), ...Array.from({ length: 7 }, () => ({ version: 'bad' }))]
    writeFileSync(file, JSON.stringify(entries), 'utf8')
    const { notes } = await serviceFor(file).getReleaseNotes()
    expect(notes.map((entry) => entry.version)).toEqual(['0.15.0'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('其余 2 处略')
  })

  it('degrades a malformed file to an empty list', async () => {
    const file = join(dir, 'release-notes.json')
    writeFileSync(file, '{ not json', 'utf8')
    const { notes } = await serviceFor(file).getReleaseNotes()
    expect(notes).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('failed to read')
  })

  it('stays silent when the file is missing (dev without resources)', async () => {
    const { notes } = await serviceFor(join(dir, 'absent.json')).getReleaseNotes()
    expect(notes).toEqual([])
    expect(warnings).toEqual([])
  })
})
