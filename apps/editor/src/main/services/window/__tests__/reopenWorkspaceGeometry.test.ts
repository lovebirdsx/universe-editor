/*---------------------------------------------------------------------------------------------
 *  Reproduction for: closing a workspace window (while other windows stay open),
 *  then reopening that workspace, loses its window position/size — it comes back
 *  at the default centred 1280x800 instead of where the user left it.
 *
 *  Drives real close/reopen events through a fake BrowserWindow and asserts the
 *  reopened window is constructed with the previously-persisted geometry.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { combinedDisposable, URI } from '@universe-editor/platform'

// --- Mock IPC bootstrap (renderer confirms shutdown immediately) ---
vi.mock('../../../ipc/registerMainServices.js', () => ({
  bootstrapWindowIpc: vi.fn(() => ({
    disposable: combinedDisposable(),
    rendererLifecycle: { confirmShutdown: vi.fn().mockResolvedValue(true) },
    rendererSessions: {} as never,
  })),
}))

// --- Mock per-window workspace stack. `current` reflects the workspace passed to
//     restoreCurrent so the service can key geometry by folder. ---
const flushSpy = vi.fn().mockResolvedValue(undefined)
vi.mock('../../storage/storageMainService.js', () => ({
  MainStorageService: vi.fn().mockImplementation(() => ({ flush: flushSpy, dispose: vi.fn() })),
}))
vi.mock('../../workspace/workspaceMainService.js', () => ({
  WorkspaceMainService: vi.fn().mockImplementation(() => {
    const state: { current: unknown } = { current: null }
    return {
      get current() {
        return state.current
      },
      onDidChangeWorkspace: vi.fn(() => ({ dispose: vi.fn() })),
      restoreCurrent: vi.fn(async (ws: unknown) => {
        state.current = ws
      }),
      dispose: vi.fn(),
    }
  }),
}))
vi.mock('../../userData/userDataMainService.js', () => ({
  UserDataMainService: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
}))
vi.mock('../../workspace/electronFolderDialog.js', () => ({
  ElectronFolderDialog: vi.fn().mockImplementation(() => ({})),
}))

// --- Capture what the app-singleton storage persists (a tiny in-memory store so
//     the per-workspace geometry map round-trips across close → reopen). ---
const store: Record<string, unknown> = {}
vi.mock('../../../storage.js', () => ({
  getDefaultStorage: () => ({
    get: vi.fn(async (key: string) => store[key]),
    set: vi.fn(async (key: string, value: unknown) => {
      store[key] = value
    }),
    remove: vi.fn(async (key: string) => {
      delete store[key]
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    flushSync: vi.fn(),
  }),
  workspaceIdFromUri: (s: string) => s,
}))

// --- Fake BrowserWindow with configurable bounds. ---
class FakeWindow extends EventEmitter {
  static nextId = 1
  readonly id = FakeWindow.nextId++
  private _destroyed = false
  bounds = { x: 100, y: 80, width: 1280, height: 800 }
  readonly webContents = Object.assign(new EventEmitter(), {
    isDevToolsOpened: () => false,
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
  })

  isDestroyed = (): boolean => this._destroyed
  isFullScreen = (): boolean => false
  isMaximized = (): boolean => false
  isMinimized = (): boolean => false
  getNormalBounds = (): { x: number; y: number; width: number; height: number } => this.bounds
  getBounds = (): { x: number; y: number; width: number; height: number } => this.bounds
  show = vi.fn()
  focus = vi.fn()
  restore = vi.fn()
  maximize = vi.fn()
  loadURL = vi.fn().mockResolvedValue(undefined)
  setFullScreen = vi.fn()
  setPosition = vi.fn()

  close(): void {
    if (this._destroyed) return
    const ev = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true
      },
    }
    this.emit('close', ev)
    if (ev.defaultPrevented) return
    this._destroyed = true
    this.emit('closed')
  }
}

const constructedOptions: Array<Record<string, unknown>> = []

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/ue-state' },
  BrowserWindow: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    constructedOptions.push(opts)
    return new FakeWindow()
  }),
  dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) },
  shell: { openExternal: vi.fn() },
  screen: {
    getAllDisplays: () => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 3000, height: 2000 },
        workArea: { x: 0, y: 0, width: 3000, height: 2000 },
      },
    ],
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 3000, height: 2000 } }),
  },
}))

const { WindowMainService } = await import('../windowMainService.js')
const { LogMainService } = await import('../../log/logMainService.js')

function makeOpts() {
  return {
    appServices: {
      recentWorkspaces: { add: vi.fn().mockResolvedValue(undefined) },
      sessionSwitcher: { registerWindow: () => {}, unregisterWindow: () => {} },
      configLocation: { onDidChangeConfigDir: () => ({ dispose: () => {} }), currentDir: '' },
    } as never,
    logService: new LogMainService(),
    e2eEnabled: false,
    rendererDebug: false,
    preloadPath: '/preload/index.cjs',
    rendererUrl: 'http://localhost:5173',
    getConfigDir: () => '/tmp/ue-state',
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const settlePersist = (): Promise<void> => sleep(1000)

describe('reopen workspace geometry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(store)) delete store[k]
    constructedOptions.length = 0
    FakeWindow.nextId = 1
  })

  it('restores the previous position/size when a closed workspace is reopened', async () => {
    const svc = new WindowMainService(makeOpts())
    const folderA = URI.file('/tmp/projA')
    const folderB = URI.file('/tmp/projB')

    // Open workspace A and a second workspace B (so the app is not quitting).
    await svc.createWindow({ workspace: { folder: folderA, name: 'projA' } })
    await svc.createWindow({ workspace: { folder: folderB, name: 'projB' } })

    const winA = svc.getWindows()[0] as unknown as FakeWindow
    // User moves/resizes window A to a distinctive geometry.
    winA.bounds = { x: 640, y: 360, width: 1600, height: 900 }
    winA.emit('resize')
    await settlePersist()

    // Close window A (B stays open → app keeps running).
    winA.close()
    await settlePersist()
    expect(svc.getWindows()).toHaveLength(1)

    constructedOptions.length = 0

    // Reopen workspace A.
    await svc.openWindowForFolder(folderA)

    const reopenedOpts = constructedOptions.at(-1)
    expect(reopenedOpts).toMatchObject({ x: 640, y: 360, width: 1600, height: 900 })
  })
}, 20000)
