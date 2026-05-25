/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/devToolsState.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('electron')>('electron')
  return { ...actual }
})

import { loadDevToolsOpen, trackDevToolsState } from '../devToolsState.js'

function makeStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial }
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return data[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      data[key] = value
    },
    async remove(key: string): Promise<void> {
      delete data[key]
    },
    async flush(): Promise<void> {},
    _data: data,
  }
}

type WebContentsListener = () => void

function makeFakeWin() {
  const listeners: Record<string, WebContentsListener[]> = {}
  return {
    webContents: {
      on(event: string, handler: WebContentsListener) {
        const arr = listeners[event] ?? (listeners[event] = [])
        arr.push(handler)
      },
      __fire(event: string) {
        listeners[event]?.forEach((h) => h())
      },
    },
  }
}

describe('loadDevToolsOpen', () => {
  it('returns false when storage has no entry', async () => {
    const storage = makeStorage()
    await expect(loadDevToolsOpen(storage)).resolves.toBe(false)
  })

  it('returns false when storage has false', async () => {
    const storage = makeStorage({ 'window.devToolsOpen': false })
    await expect(loadDevToolsOpen(storage)).resolves.toBe(false)
  })

  it('returns true when storage has true', async () => {
    const storage = makeStorage({ 'window.devToolsOpen': true })
    await expect(loadDevToolsOpen(storage)).resolves.toBe(true)
  })
})

describe('trackDevToolsState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves true when devtools-opened fires', async () => {
    const storage = makeStorage()
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackDevToolsState(win as any, storage)
    win.webContents.__fire('devtools-opened')
    await storage.flush()
    expect(storage._data['window.devToolsOpen']).toBe(true)
  })

  it('saves false when devtools-closed fires', async () => {
    const storage = makeStorage({ 'window.devToolsOpen': true })
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackDevToolsState(win as any, storage)
    win.webContents.__fire('devtools-closed')
    await storage.flush()
    expect(storage._data['window.devToolsOpen']).toBe(false)
  })

  it('tracks multiple open/close cycles', async () => {
    const storage = makeStorage()
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackDevToolsState(win as any, storage)

    win.webContents.__fire('devtools-opened')
    await storage.flush()
    expect(storage._data['window.devToolsOpen']).toBe(true)

    win.webContents.__fire('devtools-closed')
    await storage.flush()
    expect(storage._data['window.devToolsOpen']).toBe(false)

    win.webContents.__fire('devtools-opened')
    await storage.flush()
    expect(storage._data['window.devToolsOpen']).toBe(true)
  })
})
