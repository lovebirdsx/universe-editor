import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DisposableTracker, localize, setDisposableTracker } from '@universe-editor/platform'
import { initializeMainNls } from '../shared/i18n/bootstrap.js'
import { installMainProtocolDispatcher } from './ipc/electronProtocol.js'
import { bootstrapWindowIpc, type SharedMainServices } from './ipc/registerMainServices.js'
import { E2E_PROBE_ARGV_FLAG } from '../shared/e2e/contract.js'
import { MainStorageService } from './services/storage/storageMainService.js'
import { MainPingService } from './services/ping/pingMainService.js'
import { FileSystemMainService } from './services/files/fileSystemMainService.js'
import { FileWatcherMainService } from './services/fileWatcher/fileWatcherMainService.js'
import { WorkspaceMainService } from './services/workspace/workspaceMainService.js'
import { ElectronFolderDialog } from './services/workspace/electronFolderDialog.js'
import { UserDataMainService } from './services/userData/userDataMainService.js'

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

// Dev-only: enable Chromium remote debugging port so VS Code's Chrome debugger
// can attach to the renderer process. Activated via VSCODE_RENDERER_DEBUG=1
// (set by the VS Code task in .vscode/tasks.json). Must be called before app.whenReady().
if (import.meta.env.DEV && process.env['VSCODE_RENDERER_DEBUG'] === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// Shared singletons created lazily on first window.
let sharedServices: SharedMainServices | null = null
let sharedUserData: UserDataMainService | null = null

function getSharedServices(): SharedMainServices {
  if (!sharedServices) {
    const storage = new MainStorageService()
    const workspace = new WorkspaceMainService(storage, new ElectronFolderDialog())
    const userData = new UserDataMainService(workspace)
    sharedUserData = userData
    sharedServices = {
      storage,
      ping: new MainPingService(),
      fileSystem: new FileSystemMainService(),
      fileWatcher: new FileWatcherMainService(),
      workspace,
      userData,
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
    title: localize('app.name', 'Universe Editor'),
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

async function loadMainSettingsText(): Promise<string> {
  try {
    return await fs.readFile(join(app.getPath('userData'), 'settings.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

void app.whenReady().then(async () => {
  initializeMainNls(await loadMainSettingsText(), app.getLocale())
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  sharedUserData?.dispose()
})
