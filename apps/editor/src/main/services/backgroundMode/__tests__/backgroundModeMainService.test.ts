/*---------------------------------------------------------------------------------------------
 *  Tests for BackgroundModeMainService: activation ordering, tray failure
 *  semantics, primary-window decisions and the tray menu template.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTempRoot } from '@universe-editor/temp-root'
import { Emitter } from '@universe-editor/platform'
import {
  DEFAULT_MOBILE_GATEWAY_CONFIG,
  type MobileGatewayConfig,
  type MobileGatewayConfigState,
  type MobileGatewayStatus,
} from '../../../../shared/ipc/mobileGatewayService.js'

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
  nativeImage: {
    createFromPath: vi.fn(),
    createFromBuffer: vi.fn(),
    createEmpty: vi.fn(),
  },
  Tray: vi.fn(),
}))

const { Menu, nativeImage } = await import('electron')
const { BackgroundModeMainService, buildTrayMenuTemplate, extractPngFromIco } =
  await import('../backgroundModeMainService.js')

function enabledConfig(overrides: Partial<MobileGatewayConfig> = {}): MobileGatewayConfig {
  return {
    ...DEFAULT_MOBILE_GATEWAY_CONFIG,
    enabled: true,
    keepRunningInBackground: true,
    ...overrides,
  }
}

const STATUS: MobileGatewayStatus = {
  state: 'running',
  listenAddress: '127.0.0.1:47321',
  lanAddresses: [],
  origins: ['http://127.0.0.1:47321'],
  insecure: false,
  bind: 'loopback',
  capabilities: { installable: false, push: false },
  connectedDeviceCount: 0,
  supportsLaunchAtLogin: false,
}

interface FakeTray {
  setToolTip: ReturnType<typeof vi.fn>
  popUpContextMenu: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  handlers: Map<string, () => void>
}

function makeTray(): FakeTray {
  const handlers = new Map<string, () => void>()
  return {
    setToolTip: vi.fn(),
    popUpContextMenu: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      handlers.set(event, listener)
    }),
    handlers,
  }
}

function makeWindows(
  initial: {
    hidden?: readonly { id: number; name: string; hiddenSeq: number }[]
    windowCount?: number
    visibleCount?: number
    focusedId?: number | null
  } = {},
) {
  const state = {
    hidden: initial.hidden ?? [],
    windowCount: initial.windowCount ?? 1,
    visibleCount: initial.visibleCount ?? 1,
    focusedId: initial.focusedId ?? null,
  }
  return {
    state,
    service: {
      getHiddenWindowInfos: vi.fn(() => state.hidden),
      getWindowCount: vi.fn(() => state.windowCount),
      getVisibleWindowCount: vi.fn(() => state.visibleCount),
      revealWindow: vi.fn(),
      revealAllHiddenWindows: vi.fn(),
      focusWindow: vi.fn(),
      getFocusedWindowId: vi.fn(() => state.focusedId),
      closeWindowWithoutVeto: vi.fn(),
    },
  }
}

function tempTrayIcon(): { path: string; dispose: () => void } {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  const dir = mkdtempSync(join(getTempRoot(), 'ue-tray-'))
  const path = join(dir, 'icon.ico')
  writeFileSync(path, Buffer.concat([header, entry, png]))
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeHarness(
  options: {
    config?: MobileGatewayConfig
    e2eEnabled?: boolean
    platform?: NodeJS.Platform
    tray?: FakeTray
    createTrayError?: Error
    nativeImageEmpty?: boolean
    trayIconPath?: string
  } = {},
) {
  const windows = makeWindows()
  const tray = options.tray ?? makeTray()
  const configEmitter = new Emitter<MobileGatewayConfigState>()
  const statusEmitter = new Emitter<MobileGatewayStatus>()
  const config = options.config ?? enabledConfig()
  const restoreSession = vi.fn(async () => undefined)
  const createWindow = vi.fn(async () => 1)
  const quit = vi.fn()
  const createTray = vi.fn(() => {
    if (options.createTrayError) throw options.createTrayError
    return tray
  })
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  const emptyImage = { isEmpty: () => true, resize: () => emptyImage }
  const image = { isEmpty: () => false, resize: () => image }
  vi.mocked(nativeImage.createFromPath).mockReturnValue(
    (options.nativeImageEmpty ? emptyImage : image) as never,
  )
  vi.mocked(nativeImage.createEmpty).mockReturnValue(emptyImage as never)
  vi.mocked(nativeImage.createFromBuffer).mockReturnValue({ resize: () => image } as never)

  const gateway = {
    getConfig: vi.fn(async () => ({ config })),
    onDidChangeConfig: configEmitter.event,
    getStatus: vi.fn(async () => STATUS),
    onDidChangeStatus: statusEmitter.event,
  }

  const service = new BackgroundModeMainService({
    windows: windows.service,
    gateway,
    restoreSession,
    createWindow,
    logger: logger as never,
    e2eEnabled: options.e2eEnabled ?? false,
    platform: options.platform ?? 'win32',
    trayIconPath: options.trayIconPath ?? '/tmp/icon.ico',
    createTray,
    quit,
  })

  return {
    service,
    windows: windows.service,
    windowState: windows.state,
    tray,
    configEmitter,
    statusEmitter,
    config,
    restoreSession,
    createWindow,
    quit,
    createTray,
    logger,
    disposeEmitters: () => {
      configEmitter.dispose()
      statusEmitter.dispose()
    },
  }
}

describe('BackgroundModeMainService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates the tray and reports active when both gateway switches are on', async () => {
    const h = makeHarness()
    try {
      await h.service.initialize()
      expect(h.createTray).toHaveBeenCalledTimes(1)
      expect(h.tray.setToolTip).toHaveBeenCalled()
      expect(h.service.isActive()).toBe(true)
      expect(h.service.shouldHideOnClose()).toBe(true)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('does nothing when either switch is off', async () => {
    const h = makeHarness({ config: enabledConfig({ keepRunningInBackground: false }) })
    try {
      await h.service.initialize()
      expect(h.createTray).not.toHaveBeenCalled()
      expect(h.service.isActive()).toBe(false)
      expect(h.service.shouldHideOnClose()).toBe(false)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('reveals hidden windows before destroying the tray, then restores when none remain', async () => {
    const h = makeHarness()
    try {
      await h.service.initialize()
      h.windowState.windowCount = 0
      h.windowState.visibleCount = 0

      h.configEmitter.fire({ config: enabledConfig({ keepRunningInBackground: false }) })
      await vi.waitFor(() => expect(h.tray.destroy).toHaveBeenCalledTimes(1))

      expect(h.windows.revealAllHiddenWindows).toHaveBeenCalledTimes(1)
      expect(h.windows.revealAllHiddenWindows.mock.invocationCallOrder[0]).toBeLessThan(
        h.tray.destroy.mock.invocationCallOrder[0]!,
      )
      await vi.waitFor(() => expect(h.restoreSession).toHaveBeenCalledTimes(1))
      expect(h.createWindow).not.toHaveBeenCalled()
      expect(h.service.isActive()).toBe(false)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('does not create a window on deactivation when windows remain', async () => {
    const h = makeHarness()
    try {
      await h.service.initialize()
      h.configEmitter.fire({ config: enabledConfig({ enabled: false }) })
      await vi.waitFor(() => expect(h.tray.destroy).toHaveBeenCalledTimes(1))
      expect(h.restoreSession).not.toHaveBeenCalled()
      expect(h.createWindow).not.toHaveBeenCalled()
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('falls back to not hiding when the tray icon is empty in production', async () => {
    const h = makeHarness({ nativeImageEmpty: true })
    try {
      await h.service.initialize()
      expect(h.createTray).not.toHaveBeenCalled()
      expect(h.service.isActive()).toBe(false)
      expect(h.service.shouldHideOnClose()).toBe(false)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('keeps hiding under E2E even when the tray cannot be created', async () => {
    const h = makeHarness({ nativeImageEmpty: true, e2eEnabled: true })
    try {
      await h.service.initialize()
      expect(h.service.isActive()).toBe(true)
      expect(h.service.shouldHideOnClose()).toBe(true)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('treats a throwing Tray constructor as tray failure in production', async () => {
    const h = makeHarness({ createTrayError: new Error('no tray') })
    try {
      await h.service.initialize()
      expect(h.service.isActive()).toBe(false)
      expect(h.service.shouldHideOnClose()).toBe(false)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('showPrimaryWindow focuses the most recently hidden window', async () => {
    const h = makeHarness()
    try {
      h.windowState.hidden = [
        { id: 3, name: 'a', hiddenSeq: 2 },
        { id: 9, name: 'b', hiddenSeq: 7 },
      ]
      await h.service.showPrimaryWindow()
      expect(h.windows.focusWindow).toHaveBeenCalledWith(9)
      expect(h.restoreSession).not.toHaveBeenCalled()
      expect(h.createWindow).not.toHaveBeenCalled()
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('showPrimaryWindow restores the session with no windows and creates one otherwise', async () => {
    const h = makeHarness()
    try {
      h.windowState.windowCount = 0
      await h.service.showPrimaryWindow()
      expect(h.restoreSession).toHaveBeenCalledTimes(1)

      h.windowState.windowCount = 2
      await h.service.showPrimaryWindow()
      expect(h.createWindow).toHaveBeenCalledTimes(1)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('activate focuses visible windows and never creates a duplicate', async () => {
    const h = makeHarness()
    try {
      h.windowState.focusedId = 4
      await h.service.handleActivate()
      expect(h.windows.focusWindow).toHaveBeenCalledWith(4)
      expect(h.createWindow).not.toHaveBeenCalled()

      h.windowState.hidden = [{ id: 2, name: 'hidden', hiddenSeq: 3 }]
      h.windowState.windowCount = 1
      await h.service.handleActivate()
      expect(h.windows.focusWindow).toHaveBeenLastCalledWith(2)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('debounces tray left clicks into one show action', async () => {
    vi.useFakeTimers()
    const h = makeHarness({ platform: 'win32' })
    try {
      await h.service.initialize()
      h.windowState.hidden = [{ id: 6, name: 'hidden', hiddenSeq: 1 }]
      const click = h.tray.handlers.get('click')!
      click()
      click()
      expect(h.windows.focusWindow).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(399)
      expect(h.windows.focusWindow).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(h.windows.focusWindow).toHaveBeenCalledTimes(1)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('opens the menu on a macOS click instead of showing a window', async () => {
    const icon = tempTrayIcon()
    const h = makeHarness({ platform: 'darwin', trayIconPath: icon.path })
    try {
      await h.service.initialize()
      h.tray.handlers.get('click')!()
      expect(h.tray.popUpContextMenu).toHaveBeenCalledTimes(1)
      expect(h.windows.focusWindow).not.toHaveBeenCalled()
    } finally {
      h.service.dispose()
      h.disposeEmitters()
      icon.dispose()
    }
  })

  it('rebuilds the menu with live hidden windows and gateway status on right-click', async () => {
    const h = makeHarness()
    try {
      await h.service.initialize()
      h.windowState.hidden = [{ id: 5, name: 'proj', hiddenSeq: 1 }]
      h.tray.handlers.get('right-click')!()

      const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0] as Array<{
        label?: string
        enabled?: boolean
        submenu?: Array<{ label?: string }>
      }>
      const hiddenSubmenu = template.find((item) => item.label === 'Hidden Windows')
      expect(hiddenSubmenu?.submenu?.map((item) => item.label)).toEqual(['proj'])
      const status = template.find((item) => item.enabled === false)
      expect(status?.label).toContain('127.0.0.1:47321')
      expect(h.tray.popUpContextMenu).toHaveBeenCalledTimes(1)
    } finally {
      h.service.dispose()
      h.disposeEmitters()
    }
  })

  it('destroys the tray on dispose', async () => {
    const h = makeHarness()
    await h.service.initialize()
    h.service.dispose()
    expect(h.tray.destroy).toHaveBeenCalledTimes(1)
    h.disposeEmitters()
  })
})

describe('buildTrayMenuTemplate', () => {
  const gateway = { state: 'running' as const, listenAddress: '127.0.0.1:47321' }

  it('disables the hidden-windows entry when nothing is hidden', () => {
    const template = buildTrayMenuTemplate({
      hiddenWindows: [],
      gateway,
      actions: { showPrimary: vi.fn(), revealWindow: vi.fn(), exit: vi.fn() },
    })
    const submenu = template.find((item) => item.label === 'Hidden Windows')?.submenu
    expect(submenu).toEqual([{ label: 'No hidden windows', enabled: false }])
  })

  it('reveals a hidden window through its menu entry', () => {
    const revealWindow = vi.fn()
    const template = buildTrayMenuTemplate({
      hiddenWindows: [
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ],
      gateway,
      actions: { showPrimary: vi.fn(), revealWindow, exit: vi.fn() },
    })
    const submenu = template.find((item) => item.label === 'Hidden Windows')?.submenu
    expect(submenu?.map((item) => item.label)).toEqual(['alpha', 'beta'])
    submenu?.[1]?.click?.()
    expect(revealWindow).toHaveBeenCalledWith(2)
  })

  it('shows the show/exit actions and a read-only status line', () => {
    const showPrimary = vi.fn()
    const exit = vi.fn()
    const template = buildTrayMenuTemplate({
      hiddenWindows: [],
      gateway,
      actions: { showPrimary, revealWindow: vi.fn(), exit },
    })
    template.find((item) => item.label === 'Show Universe Editor')?.click?.()
    template.find((item) => item.label === 'Exit')?.click?.()
    expect(showPrimary).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(template.some((item) => item.type === 'separator')).toBe(true)
    expect(template.find((item) => item.label?.startsWith('Phone gateway'))?.enabled).toBe(false)
  })

  it('renders each gateway state without leaking undefined', () => {
    const labelFor = (state: 'running' | 'starting' | 'error' | 'stopped', address?: string) =>
      buildTrayMenuTemplate({
        hiddenWindows: [],
        gateway: { state, ...(address !== undefined ? { listenAddress: address } : {}) },
        actions: { showPrimary: vi.fn(), revealWindow: vi.fn(), exit: vi.fn() },
      }).find((item) => item.label?.startsWith('Phone gateway'))?.label

    expect(labelFor('running', '1.2.3.4:1')).toContain('1.2.3.4:1')
    expect(labelFor('running')).not.toContain('undefined')
    expect(labelFor('starting')).toContain('starting')
    expect(labelFor('error')).toContain('error')
    expect(labelFor('stopped')).toContain('stopped')
  })
})

describe('extractPngFromIco', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])

  function ico(entries: readonly { width: number; data: Buffer }[]): Buffer {
    const header = Buffer.alloc(6)
    header.writeUInt16LE(0, 0)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(entries.length, 4)
    let offset = 6 + entries.length * 16
    const directory = Buffer.alloc(entries.length * 16)
    const payloads: Buffer[] = []
    entries.forEach((entry, index) => {
      const at = index * 16
      directory.writeUInt8(entry.width, at)
      directory.writeUInt8(entry.width, at + 1)
      directory.writeUInt32LE(entry.data.length, at + 8)
      directory.writeUInt32LE(offset, at + 12)
      payloads.push(entry.data)
      offset += entry.data.length
    })
    return Buffer.concat([header, directory, ...payloads])
  }

  it('returns the largest embedded PNG data', () => {
    const small = Buffer.concat([PNG, Buffer.from([1])])
    const large = Buffer.concat([PNG, Buffer.from([2, 3, 4])])
    const extracted = extractPngFromIco(
      ico([
        { width: 16, data: small },
        { width: 0, data: large },
      ]),
    )
    expect(extracted?.equals(large)).toBe(true)
  })

  it('rejects a non-icon file and a directory without PNG payloads', () => {
    const notAnIcon = Buffer.alloc(6)
    notAnIcon.writeUInt16LE(2, 2)
    expect(extractPngFromIco(notAnIcon)).toBeUndefined()

    const bitmapEntry = ico([{ width: 32, data: Buffer.from([1, 2, 3]) }])
    expect(extractPngFromIco(bitmapEntry)).toBeUndefined()
  })

  it('is undefined for truncated input', () => {
    expect(extractPngFromIco(Buffer.alloc(0))).toBeUndefined()
    expect(extractPngFromIco(Buffer.from([0, 0, 1, 0, 4, 0]))).toBeUndefined()
  })
})
