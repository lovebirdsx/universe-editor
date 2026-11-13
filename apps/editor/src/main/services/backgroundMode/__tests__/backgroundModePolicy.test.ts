import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_IDLE_RECLAIM_MS,
  BACKGROUND_IDLE_SCAN_INTERVAL_MS,
  decideActivateAction,
  decidePrimaryWindowAction,
  isBackgroundModeActive,
  planSessionPersist,
  supportsLoginItem,
} from '../backgroundModePolicy.js'

describe('supportsLoginItem', () => {
  it('allows packaged Windows and macOS builds', () => {
    expect(supportsLoginItem({ isPackaged: true, platform: 'win32', e2e: false })).toBe(true)
    expect(supportsLoginItem({ isPackaged: true, platform: 'darwin', e2e: false })).toBe(true)
  })

  it('rejects development builds', () => {
    expect(supportsLoginItem({ isPackaged: false, platform: 'win32', e2e: false })).toBe(false)
    expect(supportsLoginItem({ isPackaged: false, platform: 'darwin', e2e: false })).toBe(false)
  })

  it('rejects platforms without a supported login item integration', () => {
    expect(supportsLoginItem({ isPackaged: true, platform: 'linux', e2e: false })).toBe(false)
  })

  it('rejects E2E runs even in packaged builds', () => {
    expect(supportsLoginItem({ isPackaged: true, platform: 'win32', e2e: true })).toBe(false)
    expect(supportsLoginItem({ isPackaged: true, platform: 'darwin', e2e: true })).toBe(false)
  })
})

describe('isBackgroundModeActive', () => {
  it('requires both the gateway and the keep-running switch', () => {
    expect(isBackgroundModeActive({ gatewayEnabled: true, keepRunningInBackground: true })).toBe(
      true,
    )
    expect(isBackgroundModeActive({ gatewayEnabled: true, keepRunningInBackground: false })).toBe(
      false,
    )
    expect(isBackgroundModeActive({ gatewayEnabled: false, keepRunningInBackground: true })).toBe(
      false,
    )
    expect(isBackgroundModeActive({ gatewayEnabled: false, keepRunningInBackground: false })).toBe(
      false,
    )
  })
})

describe('decidePrimaryWindowAction', () => {
  it('shows the most recently hidden window when one exists', () => {
    expect(
      decidePrimaryWindowAction({
        hidden: [
          { id: 1, hiddenSeq: 4 },
          { id: 2, hiddenSeq: 9 },
          { id: 3, hiddenSeq: 7 },
        ],
        liveWindowCount: 3,
      }),
    ).toEqual({ kind: 'show-hidden', windowId: 2 })
  })

  it('restores the persisted session when no window is alive', () => {
    expect(decidePrimaryWindowAction({ hidden: [], liveWindowCount: 0 })).toEqual({
      kind: 'restore',
    })
  })

  it('creates an empty window when visible windows exist but none are hidden', () => {
    expect(decidePrimaryWindowAction({ hidden: [], liveWindowCount: 2 })).toEqual({
      kind: 'create',
    })
  })
})

describe('decideActivateAction', () => {
  it('focuses an existing visible window instead of creating another one', () => {
    expect(
      decideActivateAction({
        hidden: [{ id: 2, hiddenSeq: 1 }],
        liveWindowCount: 2,
      }),
    ).toEqual({ kind: 'focus' })
  })

  it('shows the most recently hidden window when every window is hidden', () => {
    expect(
      decideActivateAction({
        hidden: [
          { id: 1, hiddenSeq: 2 },
          { id: 2, hiddenSeq: 8 },
        ],
        liveWindowCount: 2,
      }),
    ).toEqual({ kind: 'show-hidden', windowId: 2 })
  })

  it('restores the saved session when no window is alive', () => {
    expect(decideActivateAction({ hidden: [], liveWindowCount: 0 })).toEqual({
      kind: 'restore',
    })
  })
})

describe('planSessionPersist', () => {
  const candidate = (entry: string, hidden: boolean, hiddenSeq = 0) => ({
    entry,
    hidden,
    hiddenSeq,
  })

  it('keeps every visible window and drops hidden ones', () => {
    expect(
      planSessionPersist([
        candidate('visible-a', false),
        candidate('hidden-a', true, 3),
        candidate('visible-b', false),
        candidate('hidden-b', true, 5),
      ]),
    ).toEqual(['visible-a', 'visible-b'])
  })

  it('keeps only the most recently hidden window when all are hidden', () => {
    expect(
      planSessionPersist([
        candidate('old', true, 1),
        candidate('newest', true, 6),
        candidate('middle', true, 3),
      ]),
    ).toEqual(['newest'])
  })

  it('returns empty for an empty window set', () => {
    expect(planSessionPersist([])).toEqual([])
  })
})

describe('idle constants', () => {
  it('reclaims after ten minutes and scans every thirty seconds', () => {
    expect(BACKGROUND_IDLE_RECLAIM_MS).toBe(10 * 60_000)
    expect(BACKGROUND_IDLE_SCAN_INTERVAL_MS).toBe(30_000)
  })
})
