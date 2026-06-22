/*---------------------------------------------------------------------------------------------
 *  Tests for RecentEditsTracker — the per-file ring buffer feeding Next Edit
 *  Suggestions. Covers appending, same-line coalescing within the time window,
 *  ring-buffer eviction past the configured limit, per-uri isolation and clear().
 *  Uses fake timers to control the coalesce window deterministically.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, type IConfigurationService } from '@universe-editor/platform'
import { RecentEditsTracker, type IContentChangeLike } from '../RecentEditsTracker.js'

class FakeConfig implements Partial<IConfigurationService> {
  values: Record<string, unknown> = {}
  private readonly _onDidChange = new Emitter<{ affectsConfiguration: (k: string) => boolean }>()
  readonly onDidChangeConfiguration = this._onDidChange
    .event as IConfigurationService['onDidChangeConfiguration']
  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined
  }
}

function change(line: number, text: string, deleted = 0): IContentChangeLike {
  return { range: { startLineNumber: line }, text, rangeLength: deleted }
}

function createTracker(config = new FakeConfig()) {
  const tracker = new RecentEditsTracker(config as unknown as IConfigurationService)
  return { tracker, config }
}

describe('RecentEditsTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records edits oldest-first', () => {
    const { tracker } = createTracker()
    tracker.record('file://a', [change(1, 'a')])
    vi.advanceTimersByTime(3000)
    tracker.record('file://a', [change(5, 'b')])
    const edits = tracker.getRecentEdits('file://a')
    expect(edits.map((e) => e.lineNumber)).toEqual([1, 5])
    expect(edits.map((e) => e.inserted)).toEqual(['a', 'b'])
  })

  it('coalesces same-line edits within the window', () => {
    const { tracker } = createTracker()
    tracker.record('file://a', [change(2, 'h', 0)])
    vi.advanceTimersByTime(100)
    tracker.record('file://a', [change(2, 'i', 1)])
    const edits = tracker.getRecentEdits('file://a')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.inserted).toBe('hi')
    expect(edits[0]?.deletedLength).toBe(1)
  })

  it('does not coalesce same-line edits past the window', () => {
    const { tracker } = createTracker()
    tracker.record('file://a', [change(2, 'h')])
    vi.advanceTimersByTime(2500)
    tracker.record('file://a', [change(2, 'i')])
    expect(tracker.getRecentEdits('file://a')).toHaveLength(2)
  })

  it('evicts the oldest beyond the configured limit', () => {
    const config = new FakeConfig()
    config.values['ai.nes.recentEditsCount'] = 3
    const { tracker } = createTracker(config)
    for (let i = 1; i <= 5; i++) {
      tracker.record('file://a', [change(i, String(i))])
      vi.advanceTimersByTime(3000)
    }
    const edits = tracker.getRecentEdits('file://a')
    expect(edits.map((e) => e.inserted)).toEqual(['3', '4', '5'])
  })

  it('isolates history per uri', () => {
    const { tracker } = createTracker()
    tracker.record('file://a', [change(1, 'a')])
    tracker.record('file://b', [change(1, 'b')])
    expect(tracker.getRecentEdits('file://a')).toHaveLength(1)
    expect(tracker.getRecentEdits('file://b')[0]?.inserted).toBe('b')
  })

  it('clears history for a uri', () => {
    const { tracker } = createTracker()
    tracker.record('file://a', [change(1, 'a')])
    tracker.clear('file://a')
    expect(tracker.getRecentEdits('file://a')).toEqual([])
  })

  it('ignores empty change lists', () => {
    const { tracker } = createTracker()
    tracker.record('file://a', [])
    expect(tracker.getRecentEdits('file://a')).toEqual([])
  })

  it('reconciles Windows drive-letter case between record and read', () => {
    // FileEditor records under the platform URI (drive letter as written, `D:`),
    // while InlineCompletionService reads under the Monaco model URI, which has
    // round-tripped to a lower-cased drive (`d:`). They must resolve to one file.
    const { tracker } = createTracker()
    tracker.record('file:///D:/ws/a.ts', [change(1, 'foo')])
    const edits = tracker.getRecentEdits('file:///d:/ws/a.ts')
    expect(edits.map((e) => e.inserted)).toEqual(['foo'])
  })
})
