/*---------------------------------------------------------------------------------------------
 *  Unit tests for WindowSessionStore — the session persistence extracted from
 *  WindowMainService (roadmap 06 · task 2). Verifies the debounce coalesces,
 *  persistNow() snapshots the live window set + writes per-workspace geometry,
 *  destroyed windows are skipped, and cancel() suppresses a pending write.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'

// --- Capture what the app-singleton storage persists ---
const store: Record<string, unknown> = {}
const setSpy = vi.fn(async (key: string, value: unknown) => {
  store[key] = value
})
vi.mock('../../../storage.js', () => ({
  getDefaultStorage: () => ({
    get: vi.fn(async (key: string) => store[key]),
    set: setSpy,
    remove: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    flushSync: vi.fn(),
  }),
  workspaceIdFromUri: (s: string) => s,
}))

// captureWindowState reads live bounds; stub to a deterministic state per window.
vi.mock('../../../windowState.js', () => ({
  captureWindowState: (win: { _state: unknown }) => win._state,
}))

const { WindowSessionStore } = await import('../windowSessionStore.js')
const { WINDOWS_SESSION_STORAGE_KEY } = await import('../../../windowsSession.js')

interface FakeState {
  x: number
  y: number
  width: number
  height: number
  isFullscreen: boolean
  isMaximized: boolean
}

function fakeWindow(opts: { destroyed?: boolean; devTools?: boolean; state?: Partial<FakeState> }) {
  const state: FakeState = {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
    isFullscreen: false,
    isMaximized: false,
    ...opts.state,
  }
  return {
    _state: state,
    isDestroyed: () => opts.destroyed ?? false,
    webContents: { isDevToolsOpened: () => opts.devTools ?? false },
  }
}

function entry(folder: string | null, winOpts: Parameters<typeof fakeWindow>[0] = {}) {
  return {
    win: fakeWindow(winOpts) as never,
    workspace: {
      current: folder ? { folder: URI.file(folder), name: folder } : undefined,
    } as never,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('WindowSessionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(store)) delete store[k]
  })

  it('persistNow writes the live window set as the session list', async () => {
    const s = new WindowSessionStore(() => [entry('/tmp/a'), entry('/tmp/b')])
    await s.persistNow()
    const list = store[WINDOWS_SESSION_STORAGE_KEY] as unknown[]
    expect(list).toHaveLength(2)
  })

  it('skips destroyed windows', async () => {
    const s = new WindowSessionStore(() => [entry('/tmp/a'), entry('/tmp/b', { destroyed: true })])
    await s.persistNow()
    expect((store[WINDOWS_SESSION_STORAGE_KEY] as unknown[]).length).toBe(1)
  })

  it('writes per-workspace geometry for windows with a workspace', async () => {
    const s = new WindowSessionStore(() => [
      entry('/tmp/a', { state: { isFullscreen: true } }),
      entry(null),
    ])
    await s.persistNow()
    // session list key + one geometry key for /tmp/a (workspaceIdFromUri = identity).
    const keys = setSpy.mock.calls.map((c) => c[0])
    expect(keys).toContain(WINDOWS_SESSION_STORAGE_KEY)
    expect(keys.some((k) => k !== WINDOWS_SESSION_STORAGE_KEY)).toBe(true)
  })

  it('schedule coalesces bursts into a single write', async () => {
    let snapshots = 0
    const s = new WindowSessionStore(() => {
      snapshots++
      return [entry('/tmp/a')]
    })
    s.schedule()
    s.schedule()
    s.schedule()
    await sleep(400)
    expect(snapshots).toBe(1)
  })

  it('cancel suppresses a pending debounced write', async () => {
    let snapshots = 0
    const s = new WindowSessionStore(() => {
      snapshots++
      return []
    })
    s.schedule()
    s.cancel()
    await sleep(400)
    expect(snapshots).toBe(0)
  })
})
