import { describe, expect, it } from 'vitest'
import {
  isMobileRewindPreview,
  isMobileRewindResult,
  isMobileSessionRef,
  isMobileSessionRefResult,
  isMobileSideTaskList,
  isMobileSideTaskSummary,
} from '../commandResults.js'

describe('command result guards', () => {
  it('accepts a complete session ref and rejects malformed halves', () => {
    expect(isMobileSessionRef({ windowId: 1, localId: 's1' })).toBe(true)
    expect(isMobileSessionRef({ windowId: 1, localId: 's1', durableId: 'durable-1' })).toBe(true)
    expect(isMobileSessionRef({ windowId: -1, localId: 's1' })).toBe(false)
    expect(isMobileSessionRef({ windowId: 1, localId: '' })).toBe(false)
    expect(isMobileSessionRef({ windowId: 1, localId: 's1', durableId: '' })).toBe(false)
    expect(isMobileSessionRef({ windowId: 1.5, localId: 's1' })).toBe(false)
    expect(isMobileSessionRefResult({ ref: { windowId: 1, localId: 's1' } })).toBe(true)
    expect(isMobileSessionRefResult({ ref: null })).toBe(false)
    expect(isMobileSessionRefResult('nope')).toBe(false)
  })

  it('accepts a rewind preview and rejects wrong types', () => {
    expect(isMobileRewindPreview({ canRewind: true, filesChanged: 0 })).toBe(true)
    expect(
      isMobileRewindPreview({
        canRewind: false,
        error: 'no checkpoint',
        filesChanged: 2,
        insertions: 1,
        deletions: 3,
      }),
    ).toBe(true)
    expect(isMobileRewindPreview({ canRewind: 'yes', filesChanged: 1 })).toBe(false)
    expect(isMobileRewindPreview({ canRewind: true, filesChanged: -1 })).toBe(false)
    expect(isMobileRewindPreview({ canRewind: true, filesChanged: 1, error: 1 })).toBe(false)
    expect(
      isMobileRewindPreview({ canRewind: true, filesChanged: 1, insertions: Number.NaN }),
    ).toBe(false)
  })

  it('accepts a rewind result and rejects wrong types', () => {
    expect(isMobileRewindResult({ canRewind: true })).toBe(true)
    expect(isMobileRewindResult({ canRewind: true, text: 'original' })).toBe(true)
    expect(isMobileRewindResult({ canRewind: false, error: 'locked' })).toBe(true)
    expect(isMobileRewindResult({ canRewind: 1 })).toBe(false)
    expect(isMobileRewindResult({ canRewind: true, text: 3 })).toBe(false)
  })

  it('validates side-task rows and lists', () => {
    const row = { id: 'side-1', title: 'Side', lastUsedAt: 1, live: true }
    expect(isMobileSideTaskSummary(row)).toBe(true)
    expect(isMobileSideTaskSummary({ ...row, id: '' })).toBe(false)
    expect(isMobileSideTaskSummary({ ...row, title: '' })).toBe(true)
    expect(isMobileSideTaskSummary({ ...row, title: 3 })).toBe(false)
    expect(isMobileSideTaskSummary({ ...row, lastUsedAt: Number.NaN })).toBe(false)
    expect(isMobileSideTaskSummary({ ...row, live: 'yes' })).toBe(false)
    expect(isMobileSideTaskList([row])).toBe(true)
    expect(isMobileSideTaskList([])).toBe(true)
    expect(isMobileSideTaskList([row, { id: '' }])).toBe(false)
    expect(isMobileSideTaskList('nope')).toBe(false)
  })
})
