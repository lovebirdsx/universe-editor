import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchShellCacheFallback } from '../pwa.js'

type Listener = (event: MessageEvent) => void

function installFakeContainer(): {
  readonly postMessage: ReturnType<typeof vi.fn>
  readonly dispatch: (type: string, data: unknown) => void
  readonly listenerCount: (type: string) => number
} {
  const listeners = new Map<string, Set<Listener>>()
  const postMessage = vi.fn()
  const container = {
    controller: { postMessage },
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener)
    },
  }
  vi.stubGlobal('navigator', { serviceWorker: container })
  return {
    postMessage,
    dispatch: (type, data) => {
      for (const listener of listeners.get(type) ?? []) listener({ data } as MessageEvent)
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('watchShellCacheFallback', () => {
  it('asks the controller for the current shell state', () => {
    const fake = installFakeContainer()
    const listener = vi.fn()

    const stop = watchShellCacheFallback(listener)

    expect(fake.postMessage).toHaveBeenCalledWith({ type: 'mobile-shell-status' })
    stop()
    expect(fake.listenerCount('message')).toBe(0)
  })

  it('reports a cached-shell broadcast', () => {
    const fake = installFakeContainer()
    const listener = vi.fn()
    watchShellCacheFallback(listener)

    fake.dispatch('message', { type: 'mobile-shell-from-cache', at: 123 })

    expect(listener).toHaveBeenCalledWith(123)
  })

  it('reports only a positive status reply', () => {
    const fake = installFakeContainer()
    const listener = vi.fn()
    watchShellCacheFallback(listener)

    fake.dispatch('message', { type: 'mobile-shell-status', fromCache: false, at: 0 })
    expect(listener).not.toHaveBeenCalled()

    fake.dispatch('message', { type: 'mobile-shell-status', fromCache: true, at: 456 })
    expect(listener).toHaveBeenCalledWith(456)
  })

  it('ignores unrelated service worker messages', () => {
    const fake = installFakeContainer()
    const listener = vi.fn()
    watchShellCacheFallback(listener)

    fake.dispatch('message', { type: 'mobile-navigate', url: '/s/x' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('does nothing when the browser has no service worker support', () => {
    vi.stubGlobal('navigator', {})
    expect(() => watchShellCacheFallback(vi.fn())()).not.toThrow()
  })
})
