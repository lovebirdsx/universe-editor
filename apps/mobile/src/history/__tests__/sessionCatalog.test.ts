import type {
  MobileSessionHistoryEntry,
  MobileSessionSummary,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { sessionRef, sessionSummary } from '../../test/protocolFixtures.js'
import {
  buildSessionCatalog,
  countSessionCatalog,
  filterSessionCatalog,
  groupSessionCatalog,
} from '../sessionCatalog.js'

function historyRow(overrides: Partial<MobileSessionHistoryEntry> = {}): MobileSessionHistoryEntry {
  return {
    durableId: 'durable-1',
    windowId: 1,
    agentId: 'echo',
    agentName: 'Echo',
    title: 'History title',
    firstPrompt: 'Fix the tests',
    workspaceName: 'demo-workspace',
    createdAt: 1_000,
    lastUsedAt: 2_000,
    ...overrides,
  }
}

function liveSummary(overrides: Partial<MobileSessionSummary> = {}): MobileSessionSummary {
  return sessionSummary('s1', {
    ref: sessionRef('s1', 1, 'durable-1'),
    title: 'Live title',
    bucket: 'in_progress',
    updatedAt: 3_000,
    ...overrides,
  })
}

describe('buildSessionCatalog', () => {
  it('merges a live inbox row into its history entry by durable id', () => {
    const rows = buildSessionCatalog([historyRow({ pinned: true })], [liveSummary()])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      durableId: 'durable-1',
      title: 'Live title',
      firstPrompt: 'Fix the tests',
      agentLabel: 'Echo',
      workspaceName: 'demo-workspace',
      updatedAt: 3_000,
      pinned: true,
      live: true,
      status: 'in_progress',
    })
    expect(rows[0]?.ref).toEqual(sessionRef('s1', 1, 'durable-1'))
  })

  it('keeps history-only and live-only rows, ignoring side tasks', () => {
    const rows = buildSessionCatalog(
      [historyRow({ durableId: 'closed-1', title: 'Closed' })],
      [
        liveSummary({ ref: sessionRef('s2', 1, 'new-1'), title: 'Brand new', updatedAt: 5_000 }),
        liveSummary({
          ref: sessionRef('s3', 1, 'side-1'),
          title: 'Side task',
          sideTaskOf: 'closed-1',
        }),
      ],
    )

    expect(rows.map((row) => row.title).sort()).toEqual(['Brand new', 'Closed'])
    expect(rows.find((row) => row.title === 'Closed')?.live).toBe(false)
    expect(rows.find((row) => row.title === 'Brand new')?.live).toBe(true)
  })

  it('sorts pinned rows first, then by recency', () => {
    const rows = buildSessionCatalog(
      [
        historyRow({ durableId: 'a', title: 'A', lastUsedAt: 5_000 }),
        historyRow({ durableId: 'b', title: 'B', lastUsedAt: 1_000, pinned: true }),
        historyRow({ durableId: 'c', title: 'C', lastUsedAt: 9_000 }),
      ],
      [],
    )

    expect(rows.map((row) => row.title)).toEqual(['B', 'C', 'A'])
  })

  it('falls back to the durable id when every title is empty', () => {
    const rows = buildSessionCatalog([historyRow({ title: '' })], [])
    expect(rows[0]?.title).toBe('durable-1')
  })
})

describe('filterSessionCatalog', () => {
  const rows = buildSessionCatalog(
    [
      historyRow({ durableId: 'closed-1', title: 'Closed', firstPrompt: 'Rename the parser' }),
      historyRow({ durableId: 'pinned-1', title: 'Pinned', pinned: true }),
    ],
    [liveSummary({ title: 'Running migration', workspaceName: 'backend' })],
  )

  it('filters by live state', () => {
    expect(filterSessionCatalog(rows, 'live', '')).toHaveLength(1)
    expect(filterSessionCatalog(rows, 'live', '')[0]?.title).toBe('Running migration')
    expect(
      filterSessionCatalog(rows, 'closed', '')
        .map((row) => row.title)
        .sort(),
    ).toEqual(['Closed', 'Pinned'])
    expect(countSessionCatalog(rows)).toEqual({ all: 3, live: 1, closed: 2 })
  })

  it('searches title, first prompt, agent and workspace case-insensitively', () => {
    expect(filterSessionCatalog(rows, 'all', 'rename').map((row) => row.title)).toEqual(['Closed'])
    expect(filterSessionCatalog(rows, 'all', 'BACKEND').map((row) => row.title)).toEqual([
      'Running migration',
    ])
    expect(filterSessionCatalog(rows, 'all', 'echo')).toHaveLength(3)
    expect(filterSessionCatalog(rows, 'all', '  ')).toHaveLength(3)
    expect(filterSessionCatalog(rows, 'all', 'nothing')).toHaveLength(0)
  })
})

describe('groupSessionCatalog', () => {
  it('groups by calendar day in fixed order and omits empty days', () => {
    const now = new Date(2026, 4, 10, 12).getTime()
    const yesterday = new Date(2026, 4, 9, 12).getTime()
    const earlier = new Date(2026, 4, 1, 12).getTime()
    const rows = buildSessionCatalog(
      [
        historyRow({ durableId: 'old', title: 'Old', lastUsedAt: earlier }),
        historyRow({ durableId: 'new', title: 'New', lastUsedAt: now }),
        historyRow({ durableId: 'mid', title: 'Mid', lastUsedAt: yesterday }),
      ],
      [],
    )

    expect(groupSessionCatalog(rows, now)).toEqual([
      { bucket: 'today', label: '今天', rows: [rows[0]] },
      { bucket: 'yesterday', label: '昨天', rows: [rows[1]] },
      { bucket: 'earlier', label: '更早', rows: [rows[2]] },
    ])
    const nextDay = new Date(2026, 4, 11, 12).getTime()
    expect(groupSessionCatalog(rows, nextDay)).toEqual([
      { bucket: 'yesterday', label: '昨天', rows: [rows[0]] },
      { bucket: 'earlier', label: '更早', rows: [rows[1], rows[2]] },
    ])
    expect(groupSessionCatalog([], now)).toEqual([])
  })
})
