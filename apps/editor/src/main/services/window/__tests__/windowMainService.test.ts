/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/window/windowMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { combinedDisposable, URI } from '@universe-editor/platform'

// --- Mock IPC bootstrap ---
vi.mock('../../../ipc/registerMainServices.js', () => ({
  bootstrapWindowIpc: vi.fn(() => combinedDisposable()),
}))

// --- Mock per-window workspace stack (kept lightweight; exercised in their own
//     unit/integration tests). Avoids real fs watchers / storage in this test. ---
vi.mock('../../storage/storageMainService.js', () => ({
  MainStorageService: vi.fn().mockImplementation(() => ({
    flush: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}))
vi.mock('../../workspace/workspaceMainService.js', () => ({
  WorkspaceMainService: vi.fn().mockImplementation(() => ({
    current: null,
    onDidChangeWorkspace: vi.fn(() => ({ dispose: vi.fn() })),
    restoreCurrent: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}))
vi.mock('../../userData/userDataMainService.js', () => ({
  UserDataMainService: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
}))
vi.mock('../../workspace/electronFolderDialog.js', () => ({
  ElectronFolderDialog: vi.fn().mockImplementation(() => ({})),
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
    removeListener: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    isMinimized: vi.fn().mockReturnValue(false),
    isMaximized: vi.fn().mockReturnValue(false),
    isFullScreen: vi.fn().mockReturnValue(false),
    getNormalBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    webContents: {
      toggleDevTools: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      openDevTools: vi.fn(),
      isDevToolsOpened: vi.fn().mockReturnValue(false),
    },
  })),
  screen: {
    getAllDisplays: vi.fn().mockReturnValue([]),
    getDisplayNearestPoint: vi.fn().mockReturnValue({ id: 1 }),
  },
}))

// Import after mocks
const { WindowMainService } = await import('../windowMainService.js')
const { LogMainService } = await import('../../log/logMainService.js')
const { WorkspaceMainService } = await import('../../workspace/workspaceMainService.js')

function makeOpts() {
  const logService = new LogMainService()
  return {
    appServices: {
      ping: {} as never,
      fileSystem: {} as never,
      fileSearch: {} as never,
      textSearch: {} as never,
      fileWatcher: {} as never,
      recentWorkspaces: {} as never,
      logFiles: {} as never,
      acpHost: {} as never,
      acpTerminal: {} as never,
      claudeBinary: {} as never,
      codexBinary: {} as never,
      disposableLeak: {} as never,
      update: {} as never,
      releaseNotes: {} as never,
      performance: {} as never,
    },
    logService,
    e2eEnabled: false,
    rendererDebug: false,
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

  it('restoreSession([]) opens a single empty window', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.restoreSession([])
    expect(svc.getWindows()).toHaveLength(1)
  })

  it('restoreSession with two entries opens two windows', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.restoreSession([
      { workspace: { folder: URI.file('/tmp/a'), name: 'a' }, devToolsOpen: false },
      { workspace: { folder: URI.file('/tmp/b'), name: 'b' }, devToolsOpen: false },
    ])
    expect(svc.getWindows()).toHaveLength(2)
  })

  it('restoreSession dedups entries with the same workspace', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.restoreSession([
      { workspace: { folder: URI.file('/tmp/dup'), name: 'dup' }, devToolsOpen: false },
      { workspace: { folder: URI.file('/tmp/dup'), name: 'dup' }, devToolsOpen: false },
    ])
    expect(svc.getWindows()).toHaveLength(1)
  })

  it('createWindow({ workspace }) restores the workspace before load', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow({ workspace: { folder: URI.file('/tmp/w'), name: 'w' } })
    const instance = vi.mocked(WorkspaceMainService).mock.results.at(-1)?.value as {
      restoreCurrent: ReturnType<typeof vi.fn>
    }
    expect(instance.restoreCurrent).toHaveBeenCalledTimes(1)
  })
})
