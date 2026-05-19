/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/window/windowMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { combinedDisposable } from '@universe-editor/platform'

// --- Mock IPC bootstrap ---
vi.mock('../../../ipc/registerMainServices.js', () => ({
  bootstrapWindowIpc: vi.fn(() => Object.assign(combinedDisposable(), { host: {} })),
}))

// --- Electron mock ---
const windowIdCounter = { value: 1 }

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_name: string) => join(tmpdir(), 'ue-wintest')),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    id: windowIdCounter.value++,
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    isMaximized: vi.fn().mockReturnValue(false),
    isFullScreen: vi.fn().mockReturnValue(false),
    getNormalBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    webContents: { toggleDevTools: vi.fn() },
  })),
  screen: {
    getAllDisplays: vi.fn().mockReturnValue([]),
    getDisplayNearestPoint: vi.fn().mockReturnValue({ id: 1 }),
  },
}))

// Import after mocks
const { WindowMainService } = await import('../windowMainService.js')
const { LogMainService } = await import('../../log/logMainService.js')

function makeOpts() {
  const logService = new LogMainService()
  return {
    appServices: {
      storage: {} as never,
      ping: {} as never,
      fileSystem: {} as never,
      fileWatcher: {} as never,
      workspace: {} as never,
      userData: {} as never,
    },
    logService,
    e2eEnabled: false,
    preloadPath: '/preload/index.cjs',
    rendererUrl: 'http://localhost:5173',
    rendererHtml: '/renderer/index.html',
  }
}

describe('WindowMainService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    windowIdCounter.value = 1
  })

  it('createWindow returns a numeric window id', async () => {
    const svc = new WindowMainService(makeOpts())
    const id = await svc.createWindow()
    expect(typeof id).toBe('number')
  })

  it('getWindows returns the created window', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow()
    expect(svc.getWindows()).toHaveLength(1)
  })

  it('createWindow twice registers two distinct windows', async () => {
    const svc = new WindowMainService(makeOpts())
    const id1 = await svc.createWindow()
    const id2 = await svc.createWindow()
    expect(id1).not.toBe(id2)
    expect(svc.getWindows()).toHaveLength(2)
  })

  it('dispose clears all windows', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow()
    svc.dispose()
    expect(svc.getWindows()).toHaveLength(0)
  })

  it('getWindowById returns undefined for unknown id', async () => {
    const svc = new WindowMainService(makeOpts())
    expect(svc.getWindowById(99999)).toBeUndefined()
  })
})
