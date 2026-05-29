/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/windowsSession.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import type { Storage } from '../storage.js'

// validateWindowState (via windowState.ts) touches electron `screen`.
vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 3000, height: 2000 } }],
    getDisplayNearestPoint: () => ({ id: 1 }),
  },
}))

const { loadSession, serializeWindow, WINDOWS_SESSION_STORAGE_KEY } =
  await import('../windowsSession.js')

function makeStorage(value?: unknown): Storage {
  const store: Record<string, unknown> = {}
  if (value !== undefined) store[WINDOWS_SESSION_STORAGE_KEY] = value
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store[key] as T | undefined
    },
    async set(key: string, v: unknown): Promise<void> {
      store[key] = v
    },
    async remove(key: string): Promise<void> {
      delete store[key]
    },
    async flush(): Promise<void> {},
  }
}

const validUi = {
  x: 100,
  y: 80,
  width: 1280,
  height: 800,
  isMaximized: false,
  isFullscreen: false,
  displayId: 1,
}

describe('windowsSession', () => {
  it('serializeWindow + loadSession round-trips a workspace window', async () => {
    const folder = URI.file('/tmp/proj')
    const persisted = serializeWindow({ folder, name: 'proj' }, validUi, true)
    const storage = makeStorage([persisted])

    const list = await loadSession(storage)
    expect(list).toHaveLength(1)
    expect(list[0]?.workspace?.folder.toString()).toBe(folder.toString())
    expect(list[0]?.workspace?.name).toBe('proj')
    expect(list[0]?.uiState).toMatchObject({ width: 1280, height: 800 })
    expect(list[0]?.devToolsOpen).toBe(true)
  })

  it('serializeWindow preserves an empty (folderless) window', async () => {
    const persisted = serializeWindow(null, validUi, false)
    const list = await loadSession(makeStorage([persisted]))
    expect(list).toHaveLength(1)
    expect(list[0]?.workspace).toBeNull()
    expect(list[0]?.devToolsOpen).toBe(false)
  })

  it('returns [] for missing / non-array values', async () => {
    expect(await loadSession(makeStorage())).toEqual([])
    expect(await loadSession(makeStorage(null))).toEqual([])
    expect(await loadSession(makeStorage({ not: 'an array' }))).toEqual([])
  })

  it('drops invalid uiState but keeps the entry', async () => {
    const bad = { ...validUi, width: 10 } // below the 200 minimum
    const persisted = serializeWindow({ folder: URI.file('/tmp/p'), name: 'p' }, bad, false)
    const list = await loadSession(makeStorage([persisted]))
    expect(list).toHaveLength(1)
    expect(list[0]?.uiState).toBeUndefined()
    expect(list[0]?.workspace?.name).toBe('p')
  })
})
