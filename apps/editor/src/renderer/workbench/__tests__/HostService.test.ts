import { afterEach, describe, expect, it, vi } from 'vitest'
import { autorun } from '@universe-editor/platform'
import { HostService } from '../host/HostService.js'

interface ApiMockOptions {
  platform?: string
  isMaximized?: boolean
}

function mockApi(opts: ApiMockOptions = {}) {
  let maximizeCallback: ((v: boolean) => void) | undefined
  const detach = vi.fn()
  const api = {
    platform: opts.platform ?? 'win32',
    ping: vi.fn(),
    storage: { get: vi.fn(), set: vi.fn() },
    windowMinimize: vi.fn().mockResolvedValue(undefined),
    windowMaximize: vi.fn().mockResolvedValue(undefined),
    windowClose: vi.fn().mockResolvedValue(undefined),
    windowIsMaximized: vi.fn().mockResolvedValue(opts.isMaximized ?? false),
    onWindowMaximizeChange: vi.fn((cb: (v: boolean) => void) => {
      maximizeCallback = cb
      return detach
    }),
  }
  ;(window as unknown as { api: typeof api }).api = api
  return {
    api,
    detach,
    fireMaximizeChange: (v: boolean) => maximizeCallback?.(v),
  }
}

describe('HostService', () => {
  afterEach(() => {
    delete (window as { api?: unknown }).api
  })

  it('reads platform from window.api', () => {
    mockApi({ platform: 'darwin' })
    const svc = new HostService()
    expect(svc.platform).toBe('darwin')
  })

  it('coerces unknown platform string to "unknown"', () => {
    mockApi({ platform: 'freebsd' })
    const svc = new HostService()
    expect(svc.platform).toBe('unknown')
  })

  it('initializes isMaximized from windowIsMaximized()', async () => {
    const { api } = mockApi({ isMaximized: true })
    const svc = new HostService()

    // initial observable value is false until the promise resolves
    expect(svc.isMaximized.get()).toBe(false)
    await vi.waitFor(() => expect(api.windowIsMaximized).toHaveBeenCalled())
    await Promise.resolve()
    expect(svc.isMaximized.get()).toBe(true)
  })

  it('subscribes to onWindowMaximizeChange and updates the observable', () => {
    const { fireMaximizeChange } = mockApi()
    const svc = new HostService()
    const spy = vi.fn()
    const d = autorun((r) => {
      svc.isMaximized.read(r)
      spy()
    })
    spy.mockClear()

    fireMaximizeChange(true)
    expect(svc.isMaximized.get()).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)

    fireMaximizeChange(false)
    expect(svc.isMaximized.get()).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
    d.dispose()
  })

  it('forwards minimize/maximize/close to window.api', async () => {
    const { api } = mockApi()
    const svc = new HostService()
    await svc.minimizeWindow()
    await svc.toggleMaximizeWindow()
    await svc.closeWindow()
    expect(api.windowMinimize).toHaveBeenCalledTimes(1)
    expect(api.windowMaximize).toHaveBeenCalledTimes(1)
    expect(api.windowClose).toHaveBeenCalledTimes(1)
  })

  it('dispose() detaches the maximize-change listener', () => {
    const { detach } = mockApi()
    const svc = new HostService()
    svc.dispose()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('survives when window.api is unavailable', async () => {
    delete (window as { api?: unknown }).api
    const svc = new HostService()
    expect(svc.platform).toBe('unknown')
    expect(svc.isMaximized.get()).toBe(false)
    await expect(svc.minimizeWindow()).resolves.toBeUndefined()
    await expect(svc.toggleMaximizeWindow()).resolves.toBeUndefined()
    await expect(svc.closeWindow()).resolves.toBeUndefined()
    expect(() => svc.dispose()).not.toThrow()
  })
})
