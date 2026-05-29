/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/devToolsState.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { observeDevToolsState } from '../devToolsState.js'

type Listener = () => void

function makeFakeWin(destroyed = false) {
  const listeners: Record<string, Listener[]> = {}
  return {
    isDestroyed: () => destroyed,
    webContents: {
      on(event: string, handler: Listener) {
        const arr = listeners[event] ?? (listeners[event] = [])
        arr.push(handler)
      },
      removeListener(event: string, handler: Listener) {
        const arr = listeners[event]
        if (arr) listeners[event] = arr.filter((h) => h !== handler)
      },
      __fire(event: string) {
        listeners[event]?.forEach((h) => h())
      },
      __count(event: string) {
        return listeners[event]?.length ?? 0
      },
    },
  }
}

describe('observeDevToolsState', () => {
  it('calls onChange when devtools-opened fires', () => {
    const win = makeFakeWin()
    const onChange = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    observeDevToolsState(win as any, onChange)
    win.webContents.__fire('devtools-opened')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('calls onChange when devtools-closed fires', () => {
    const win = makeFakeWin()
    const onChange = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    observeDevToolsState(win as any, onChange)
    win.webContents.__fire('devtools-closed')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('dispose removes both listeners', () => {
    const win = makeFakeWin()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const disposable = observeDevToolsState(win as any, vi.fn())
    expect(win.webContents.__count('devtools-opened')).toBe(1)
    expect(win.webContents.__count('devtools-closed')).toBe(1)
    disposable.dispose()
    expect(win.webContents.__count('devtools-opened')).toBe(0)
    expect(win.webContents.__count('devtools-closed')).toBe(0)
  })

  it('dispose is a no-op when the window is already destroyed', () => {
    const win = makeFakeWin(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const disposable = observeDevToolsState(win as any, vi.fn())
    // listeners stay attached (window gone), but dispose must not throw
    expect(() => disposable.dispose()).not.toThrow()
  })
})
