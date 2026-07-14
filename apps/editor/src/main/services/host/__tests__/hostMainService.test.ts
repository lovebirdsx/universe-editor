/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/host/hostMainService.ts
 *  Covers the per-window state delegation, the maximize/unmaximize event bridge,
 *  the restart veto chain, and listener cleanup on dispose — all without spawning
 *  external processes (openInVSCode/openTerminal shell out and are OS-specific).
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShutdownReason } from '@universe-editor/platform'

vi.mock('electron', () => ({
  app: { getName: () => 'Test', getVersion: () => '1.0.0', getPath: () => '/tmp' },
  dialog: {},
  shell: {},
  nativeImage: {},
  Notification: { isSupported: () => false },
}))

const { MainHostService } = await import('../hostMainService.js')

class FakeWindow extends EventEmitter {
  readonly id = 7
  private _maximized = false
  private _destroyed = false
  reloadCount = 0
  zoomLevel = 0

  readonly webContents = {
    toggleDevTools: (): void => {},
    getZoomLevel: (): number => this.zoomLevel,
    setZoomLevel: (level: number): void => {
      this.zoomLevel = level
    },
  }

  isMaximized(): boolean {
    return this._maximized
  }
  maximize(): void {
    this._maximized = true
  }
  unmaximize(): void {
    this._maximized = false
  }
  isDestroyed(): boolean {
    return this._destroyed
  }
  destroy(): void {
    this._destroyed = true
  }
  reload(): void {
    this.reloadCount++
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asWin(): any {
    return this
  }
}

describe('MainHostService', () => {
  let win: FakeWindow

  beforeEach(() => {
    win = new FakeWindow()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports and toggles the maximized state of its window', async () => {
    const svc = new MainHostService(win.asWin())
    expect(await svc.isMaximized()).toBe(false)
    await svc.toggleMaximizeWindow()
    expect(await svc.isMaximized()).toBe(true)
    await svc.toggleMaximizeWindow()
    expect(await svc.isMaximized()).toBe(false)
    svc.dispose()
  })

  it('bridges maximize / unmaximize window events to onDidChangeMaximized', () => {
    const svc = new MainHostService(win.asWin())
    const seen: boolean[] = []
    svc.onDidChangeMaximized((v) => seen.push(v))

    win.emit('maximize')
    win.emit('unmaximize')
    expect(seen).toEqual([true, false])
    svc.dispose()
  })

  it('openNewWindow delegates to the injected factory', async () => {
    const createNewWindow = vi.fn()
    const svc = new MainHostService(win.asWin(), createNewWindow)
    await svc.openNewWindow()
    expect(createNewWindow).toHaveBeenCalledOnce()
    svc.dispose()
  })

  it('restart reloads the window when the renderer does not veto', async () => {
    const confirmShutdown = vi.fn().mockResolvedValue(true)
    const svc = new MainHostService(win.asWin(), () => {}, undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getRendererLifecycle: () => ({ confirmShutdown }) as any,
    })
    await svc.restart()
    expect(confirmShutdown).toHaveBeenCalledWith(ShutdownReason.Reload)
    expect(win.reloadCount).toBe(1)
    svc.dispose()
  })

  it('restart is vetoed when the renderer declines', async () => {
    const confirmShutdown = vi.fn().mockResolvedValue(false)
    const svc = new MainHostService(win.asWin(), () => {}, undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getRendererLifecycle: () => ({ confirmShutdown }) as any,
    })
    await svc.restart()
    expect(win.reloadCount).toBe(0)
    svc.dispose()
  })

  it('restart proceeds when the veto check throws', async () => {
    const svc = new MainHostService(win.asWin(), () => {}, undefined, {
      getRendererLifecycle: () =>
        ({
          confirmShutdown: () => Promise.reject(new Error('ipc down')),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    })
    await svc.restart()
    expect(win.reloadCount).toBe(1)
    svc.dispose()
  })

  it('dispose removes window listeners', () => {
    const svc = new MainHostService(win.asWin())
    expect(win.listenerCount('maximize')).toBe(1)
    expect(win.listenerCount('unmaximize')).toBe(1)
    svc.dispose()
    expect(win.listenerCount('maximize')).toBe(0)
    expect(win.listenerCount('unmaximize')).toBe(0)
  })

  it('reports product/runtime version info', async () => {
    const svc = new MainHostService(win.asWin())
    const info = await svc.getVersionInfo()
    expect(info.productName).toBe('Test')
    expect(info.version).toBe('1.0.0')
    expect(info.node).toBe(process.versions.node)
    svc.dispose()
  })

  it('zoom in / out steps the zoom level and reset returns to zero', async () => {
    const svc = new MainHostService(win.asWin())
    await svc.zoomIn()
    expect(win.zoomLevel).toBe(1)
    await svc.zoomIn()
    expect(win.zoomLevel).toBe(2)
    await svc.zoomOut()
    expect(win.zoomLevel).toBe(1)
    await svc.resetZoom()
    expect(win.zoomLevel).toBe(0)
    svc.dispose()
  })

  it('clamps the zoom level to the webFrame range', async () => {
    const svc = new MainHostService(win.asWin())
    win.zoomLevel = 9
    await svc.zoomIn()
    expect(win.zoomLevel).toBe(9)
    win.zoomLevel = -8
    await svc.zoomOut()
    expect(win.zoomLevel).toBe(-8)
    svc.dispose()
  })
})
