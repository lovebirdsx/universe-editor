import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DisposableTracker, setDisposableTracker } from '@universe-editor/platform'
import { installMainProtocolDispatcher } from './ipc/electronProtocol.js'
import { bootstrapWindowIpc, type SharedMainServices } from './ipc/registerMainServices.js'
import { E2E_PROBE_ARGV_FLAG } from '../shared/e2e/contract.js'
import { MainStorageService } from './services/storage/storageMainService.js'
import { MainPingService } from './services/ping/pingMainService.js'
import { FileSystemMainService } from './services/files/fileSystemMainService.js'
import { FileWatcherMainService } from './services/fileWatcher/fileWatcherMainService.js'
import { WorkspaceMainService } from './services/workspace/workspaceMainService.js'
import { ElectronFolderDialog } from './services/workspace/electronFolderDialog.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Dev-only: track Disposable leaks. Report on process exit.
if (import.meta.env.DEV) {
  const tracker = new DisposableTracker()
  setDisposableTracker(tracker)
  process.on('exit', () => {
    const report = tracker.computeLeakingDisposables()
    if (report) {
      console.warn(`[main] ${report.leaks.length} Disposable leak(s) detected:\n${report.details}`)
    }
  })
}

// Shared singletons created lazily on first window.
let sharedServices: SharedMainServices | null = null

function getSharedServices(): SharedMainServices {
  if (!sharedServices) {
    const storage = new MainStorageService()
    sharedServices = {
      storage,
      ping: new MainPingService(),
      fileSystem: new FileSystemMainService(),
      fileWatcher: new FileWatcherMainService(),
      workspace: new WorkspaceMainService(storage, new ElectronFolderDialog()),
    }
  }
  return sharedServices
}

const e2eEnabled = process.env['UNIVERSE_E2E'] === '1'

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Universe Editor',
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 8, y: 8 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(e2eEnabled ? { additionalArguments: [E2E_PROBE_ARGV_FLAG] } : {}),
    },
  })

  const ipc = bootstrapWindowIpc(win, getSharedServices())
  win.on('closed', () => ipc.dispose())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

installMainProtocolDispatcher()

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
