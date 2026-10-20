/*---------------------------------------------------------------------------------------------
 *  Tests for the auxiliary-window main service: token ownership, security policy,
 *  close veto, scoped API isolation and lifecycle cleanup.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerDetails } from 'electron'

const display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
}

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
  screen: {
    getAllDisplays: vi.fn(() => [display]),
    getDisplayNearestPoint: vi.fn(() => display),
  },
}))

const { AuxiliaryWindowsMainService, WindowScopedAuxiliaryWindowsService } =
  await import('../auxiliaryWindowsMainService.js')
const { BrowserWindow, screen } = await import('electron')

interface CloseEventLike {
  defaultPrevented: boolean
  preventDefault(): void
}

class FakeWebContents extends EventEmitter {
  id = 100
  openHandler: (() => { action: 'deny' }) | undefined
  zoomLevel = 0
  url = 'about:blank'

  setWindowOpenHandler(handler: () => { action: 'deny' }): void {
    this.openHandler = handler
  }

  getZoomLevel(): number {
    return this.zoomLevel
  }

  setZoomLevel(level: number): void {
    this.zoomLevel = level
  }

  getURL(): string {
    return this.url
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  destroyed = false
  visible = false
  focused = false
  minimized = false
  maximized = false
  fullscreen = false
  menu: unknown = 'default'
  bounds = { x: 40, y: 40, width: 1280, height: 800 }
  lastCloseEvent: CloseEventLike | undefined

  constructor(readonly id: number) {
    super()
  }

  show(): void {
    this.visible = true
  }

  showInactive(): void {
    this.visible = true
  }

  focus(): void {
    this.visible = true
    this.focused = true
    this.emit('focus')
  }

  close(): void {
    if (this.destroyed) return
    const event: CloseEventLike = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    this.lastCloseEvent = event
    this.emit('close', event)
    if (!event.defaultPrevented) this.destroy()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }

  setMenu(menu: unknown): void {
    this.menu = menu
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  isFocused(): boolean {
    return this.focused
  }

  isMaximized(): boolean {
    return this.maximized
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isFullScreen(): boolean {
    return this.fullscreen
  }

  minimize(): void {
    this.minimized = true
  }

  restore(): void {
    this.minimized = false
  }

  maximize(): void {
    this.maximized = true
    this.emit('maximize')
  }

  unmaximize(): void {
    this.maximized = false
    this.emit('unmaximize')
  }

  setFullScreen(value: boolean): void {
    this.fullscreen = value
  }

  setPosition(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y }
  }

  getNormalBounds(): typeof display.bounds {
    return { ...this.bounds }
  }

  getBounds(): typeof display.bounds {
    return { ...this.bounds }
  }
}

type Service = InstanceType<typeof AuxiliaryWindowsMainService>
type Scoped = InstanceType<typeof WindowScopedAuxiliaryWindowsService>

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function createService(silentE2E = false, platform: NodeJS.Platform = 'linux'): Service {
  return new AuxiliaryWindowsMainService({
    preloadPath: '/preload/auxiliary.cjs',
    silentE2E,
    logService: { createLogger: () => logger } as never,
    appName: 'Universe Editor',
    platform,
  })
}

function details(frameName: string, url = 'about:blank'): HandlerDetails {
  return { frameName, url } as HandlerDetails
}

function createWindow(
  service: Service,
  parent: FakeWindow,
  options?: Parameters<Scoped['prepareOpen']>[0],
): { token: string; child: FakeWindow } {
  const prepared = service.prepareOpen(parent.id, options)
  const response = service.handleWindowOpen(parent as never, 'about:blank', prepared.frameName)
  expect(response?.action).toBe('allow')
  const child = new FakeWindow(100 + service.getWindows(parent.id).length + 1)
  const adopted = service.adoptCreatedWindow(
    parent as never,
    child as never,
    details(prepared.frameName),
  )
  expect(adopted).toBe(true)
  return { token: prepared.token, child }
}

let nextParentId = 1

function makeParent(service: Service): FakeWindow {
  const parent = new FakeWindow(nextParentId++)
  service.registerParent(parent as never)
  return parent
}

describe('AuxiliaryWindowsMainService', () => {
  let service: Service

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null)
    vi.mocked(screen.getAllDisplays).mockReturnValue([display as never])
    vi.mocked(screen.getDisplayNearestPoint).mockReturnValue(display as never)
    service = createService()
    logger.info.mockClear()
    logger.warn.mockClear()
    logger.error.mockClear()
  })

  afterEach(() => {
    service.dispose()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('reserves a one-time token and applies hardened, clamped window options', () => {
    const parent = makeParent(service)
    const prepared = service.prepareOpen(parent.id, {
      geometry: { x: -5000, y: -5000, width: 5000, height: 5000 },
      title: 'Aux',
    })
    expect(prepared.token).toBe(prepared.frameName)
    expect(prepared.token).toMatch(/^[0-9a-f]{48}$/)

    const response = service.handleWindowOpen(parent as never, 'about:blank', prepared.frameName)
    expect(response?.action).toBe('allow')
    const options = response?.overrideBrowserWindowOptions
    expect(options).toMatchObject({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
      show: false,
      frame: false,
      title: 'Aux',
    })
    // The renderer draws the title bar so it can follow the theme; a native
    // frame would be OS-colored.
    expect(options).not.toHaveProperty('titleBarStyle')
    expect(options?.webPreferences).toMatchObject({
      preload: '/preload/auxiliary.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
    })

    const child = new FakeWindow(50)
    expect(
      service.adoptCreatedWindow(parent as never, child as never, details(prepared.frameName)),
    ).toBe(true)
    expect(child.webContents.openHandler?.()).toEqual({ action: 'deny' })
  })

  it('keeps the traffic lights on macOS instead of using a native frame', () => {
    const mac = createService(false, 'darwin')
    const parent = makeParent(mac)
    const prepared = mac.prepareOpen(parent.id)
    const response = mac.handleWindowOpen(parent as never, 'about:blank', prepared.frameName)
    const options = response?.overrideBrowserWindowOptions

    expect(options).toMatchObject({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 8, y: 8 },
    })
    expect(options).not.toHaveProperty('frame')
    mac.dispose()
  })

  it('denies about:blank without a token and leaves other URLs to the caller', () => {
    const parent = makeParent(service)
    const otherParent = makeParent(service)
    const prepared = service.prepareOpen(parent.id)

    expect(service.handleWindowOpen(parent as never, 'about:blank', 'missing')).toEqual({
      action: 'deny',
    })
    expect(
      service.handleWindowOpen(parent as never, 'https://example.com', 'missing'),
    ).toBeUndefined()
    expect(
      service.handleWindowOpen(otherParent as never, 'about:blank', prepared.frameName),
    ).toEqual({
      action: 'deny',
    })
  })

  it('consumes the token on creation and destroys a second child reusing it', () => {
    const parent = makeParent(service)
    const { token } = createWindow(service, parent)

    expect(service.handleWindowOpen(parent as never, 'about:blank', token)).toEqual({
      action: 'deny',
    })

    const duplicate = new FakeWindow(77)
    expect(service.adoptCreatedWindow(parent as never, duplicate as never, details(token))).toBe(
      false,
    )
    expect(duplicate.isDestroyed()).toBe(true)
  })

  it('vetoes user close, reports the request to the parent renderer, then finalizes', () => {
    const parent = makeParent(service)
    const scoped = new WindowScopedAuxiliaryWindowsService(service, parent.id)
    const requests: string[] = []
    scoped.onDidRequestClose((event) => requests.push(event.token))
    const closed: string[] = []
    scoped.onDidCloseWindow((event) => closed.push(event.token))

    const { token, child } = createWindow(service, parent)
    child.close()

    expect(child.isDestroyed()).toBe(false)
    expect(child.lastCloseEvent?.defaultPrevented).toBe(true)
    expect(requests).toEqual([token])

    service.finalizeClose(parent.id, token)
    expect(child.isDestroyed()).toBe(true)
    expect(closed).toEqual([token])
  })

  it('does not let one parent renderer control another parent’s window', async () => {
    const first = makeParent(service)
    const second = makeParent(service)
    const scopedFirst = new WindowScopedAuxiliaryWindowsService(service, first.id)
    const firstChild = createWindow(service, first)
    const secondChild = createWindow(service, second)

    const requests: string[] = []
    scopedFirst.onDidRequestClose((event) => requests.push(event.token))
    secondChild.child.close()
    expect(requests).toEqual([])

    expect(await scopedFirst.getWindowState(secondChild.token)).toBeNull()
    expect((await scopedFirst.getWindows()).map((entry) => entry.token)).toEqual([firstChild.token])
    await expect(scopedFirst.focusWindow(secondChild.token)).rejects.toThrow(
      'Unknown auxiliary window token',
    )
    await expect(scopedFirst.finalizeClose(secondChild.token)).resolves.toBeUndefined()
    expect(secondChild.child.isDestroyed()).toBe(false)

    // Prevent the afterEach cleanup from tripping over vetoed siblings.
    service.disposeParent(second.id, 'test-cleanup')
  })

  it('tears down only the disposed parent’s children and reservations', () => {
    const first = makeParent(service)
    const second = makeParent(service)
    const firstChild = createWindow(service, first)
    const secondChild = createWindow(service, second)
    const pending = service.prepareOpen(first.id)

    service.disposeParent(first.id, 'parent-close')

    expect(firstChild.child.isDestroyed()).toBe(true)
    expect(secondChild.child.isDestroyed()).toBe(false)
    expect(service.handleWindowOpen(first as never, 'about:blank', pending.frameName)).toEqual({
      action: 'deny',
    })
  })

  it('keeps a live parent registered across a reload so the new renderer can reopen', () => {
    const parent = makeParent(service)
    createWindow(service, parent)
    service.disposeParent(parent.id, 'parent-reload')

    // The BrowserWindow survives the reload; the rebuilt renderer must be able
    // to prepare new auxiliary windows for the same parent.
    expect(() => service.prepareOpen(parent.id)).not.toThrow()

    parent.destroy()
    expect(() => service.prepareOpen(parent.id)).toThrow(/closed parent/)
  })

  it('blocks navigation, webviews and nested windows without blocking iframes', () => {
    const parent = makeParent(service)
    const { child } = createWindow(service, parent)
    const webContents = child.webContents

    for (const eventName of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
      const event = { preventDefault: vi.fn() }
      webContents.emit(eventName, event)
      expect(event.preventDefault, eventName).toHaveBeenCalled()
    }
    // Same-document iframes stay available: only the main-frame navigation hooks exist.
    expect(webContents.listenerCount('will-frame-navigate')).toBe(0)
    expect(webContents.openHandler?.()).toEqual({ action: 'deny' })
  })

  it('emits debounced geometry changes and clamps auxiliary zoom', async () => {
    const parent = makeParent(service)
    const scoped = new WindowScopedAuxiliaryWindowsService(service, parent.id)
    const states: number[] = []
    scoped.onDidChangeWindowState((state) => states.push(state.geometry.width))

    const { token, child } = createWindow(service, parent)
    child.bounds = { x: 200, y: 120, width: 900, height: 700 }
    child.emit('move')
    await vi.advanceTimersByTimeAsync(500)
    expect(states.at(-1)).toBe(900)

    for (let i = 0; i < 20; i++) await scoped.zoomIn(token)
    expect(child.webContents.getZoomLevel()).toBe(9)
    for (let i = 0; i < 30; i++) await scoped.zoomOut(token)
    expect(child.webContents.getZoomLevel()).toBe(-8)
    await scoped.resetZoom(token)
    expect(child.webContents.getZoomLevel()).toBe(0)
  })

  it('applies restored maximized state and shows silently in E2E mode', () => {
    const silent = createService(true)
    const parent = makeParent(silent)
    const prepared = silent.prepareOpen(parent.id, {
      geometry: { x: 300, y: 200, width: 800, height: 600, isMaximized: true },
    })
    silent.handleWindowOpen(parent as never, 'about:blank', prepared.frameName)
    const child = new FakeWindow(90)
    silent.adoptCreatedWindow(parent as never, child as never, details(prepared.frameName))
    child.webContents.emit('did-finish-load')

    expect(child.isMaximized()).toBe(true)
    expect(child.isVisible()).toBe(true)
    expect(child.isFocused()).toBe(false)
    silent.dispose()
  })

  it('forwards minimize and maximize toggles, repainting state immediately', async () => {
    const parent = makeParent(service)
    const scoped = new WindowScopedAuxiliaryWindowsService(service, parent.id)
    const maximizedStates: boolean[] = []
    scoped.onDidChangeWindowState((state) => maximizedStates.push(state.geometry.isMaximized))
    const { token, child } = createWindow(service, parent)

    await scoped.minimizeWindow(token)
    expect(child.isMinimized()).toBe(true)

    await scoped.toggleMaximizeWindow(token)
    expect(child.isMaximized()).toBe(true)
    expect(maximizedStates.at(-1)).toBe(true)

    await scoped.toggleMaximizeWindow(token)
    expect(child.isMaximized()).toBe(false)
    expect(maximizedStates.at(-1)).toBe(false)
  })

  it('restores a minimized auxiliary window before focusing it', async () => {
    const parent = makeParent(service)
    const scoped = new WindowScopedAuxiliaryWindowsService(service, parent.id)
    const { token, child } = createWindow(service, parent)
    child.minimize()
    expect(child.isMinimized()).toBe(true)

    await scoped.focusWindow(token)

    expect(child.isMinimized()).toBe(false)
    expect(child.isFocused()).toBe(true)
  })

  it('follows a focused auxiliary window when choosing a native dialog parent', () => {
    const parent = makeParent(service)
    const otherParent = makeParent(service)
    const { child } = createWindow(service, parent)

    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(child as never)
    expect(service.getDialogParent(parent.id, parent as never)).toBe(child)

    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(otherParent as never)
    expect(service.getDialogParent(parent.id, parent as never)).toBe(parent)
  })
})
