import { vi } from 'vitest'
import { tmpdir } from 'node:os'

// Minimal electron mock for integration tests running in plain Node.
// app.getPath is a vi.fn() so individual tests can override per-test:
//   vi.mocked(app.getPath).mockReturnValue(userDataDir)
//
// vi.mock() is hoisted before any imports, so all service modules that
// `import { app } from 'electron'` will receive this mock object.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_name: string) => tmpdir()),
    on: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    getLocale: vi.fn(() => 'en'),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    webContents: { send: vi.fn(), reload: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    show: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
  })),
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  shell: {
    openPath: vi.fn(async () => ''),
  },
}))
