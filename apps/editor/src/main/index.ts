import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { DisposableTracker, setDisposableTracker } from '@universe-editor/platform'
import { initializeMainNls } from '../shared/i18n/bootstrap.js'
import { installMainProtocolDispatcher } from './ipc/electronProtocol.js'
import { MainStorageService } from './services/storage/storageMainService.js'
import { MainPingService } from './services/ping/pingMainService.js'
import { FileSystemMainService } from './services/files/fileSystemMainService.js'
import { FileWatcherMainService } from './services/fileWatcher/fileWatcherMainService.js'
import { WorkspaceMainService } from './services/workspace/workspaceMainService.js'
import { ElectronFolderDialog } from './services/workspace/electronFolderDialog.js'
import { UserDataMainService } from './services/userData/userDataMainService.js'
import { LogMainService } from './services/log/logMainService.js'
import { LogFilesMainService } from './services/log/logFilesMainService.js'
import { WindowMainService } from './services/window/windowMainService.js'
import { AcpHostMainService } from './services/acpHost/acpHostMainService.js'
import { AcpTerminalMainService } from './services/acpTerminal/acpTerminalMainService.js'
import { installMainErrorHandlers } from './errors.js'
import type { ApplicationServices } from './window/scopedServicesFactory.js'

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

// Install global error handlers as early as possible (before any async work).
const logMainService = new LogMainService()
const mainLogger = logMainService.createLogger({ id: 'main', name: 'Main' })
installMainErrorHandlers(mainLogger)

const e2eEnabled = process.env['UNIVERSE_E2E'] === '1'

// Application-singleton services — shared across all windows.
let applicationServices: ApplicationServices | null = null
let userDataService: UserDataMainService | null = null
let acpHostService: AcpHostMainService | null = null
let acpTerminalService: AcpTerminalMainService | null = null
let windowMainService: WindowMainService | null = null
const appIconPath = join(__dirname, '../../build/icon.ico')

function getOrCreateServices(): { app: ApplicationServices; windows: WindowMainService } {
  if (!applicationServices) {
    mainLogger.info('create application services')
    const storage = new MainStorageService()
    const workspace = new WorkspaceMainService(
      storage,
      new ElectronFolderDialog(),
      logMainService.createLogger({ id: 'workspace', name: 'Workspace' }),
    )
    const userData = new UserDataMainService(workspace)
    userDataService = userData
    const acpHost = new AcpHostMainService(
      logMainService.createLogger({ id: 'acpHost', name: 'ACP Host' }),
    )
    acpHostService = acpHost
    const acpTerminal = new AcpTerminalMainService(
      logMainService.createLogger({ id: 'acpTerminal', name: 'ACP Terminal' }),
    )
    acpTerminalService = acpTerminal
    applicationServices = {
      storage,
      ping: new MainPingService(),
      fileSystem: new FileSystemMainService(
        logMainService.createLogger({ id: 'fileSystem', name: 'File System' }),
      ),
      fileWatcher: new FileWatcherMainService(
        logMainService.createLogger({ id: 'fileWatcher', name: 'File Watcher' }),
      ),
      workspace,
      userData,
      logFiles: new LogFilesMainService(logMainService),
      acpHost,
      acpTerminal,
    }
  }
  if (!windowMainService) {
    windowMainService = new WindowMainService({
      appServices: applicationServices,
      logService: logMainService,
      e2eEnabled,
      ...(existsSync(appIconPath) ? { appIconPath } : {}),
      preloadPath: join(__dirname, '../preload/index.cjs'),
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
      rendererHtml: join(__dirname, '../renderer/index.html'),
    })
  }
  return { app: applicationServices, windows: windowMainService }
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
  mainLogger.info(`app ready locale=${app.getLocale()} e2e=${e2eEnabled}`)
  initializeMainNls(await loadMainSettingsText(), app.getLocale())
  const { windows } = getOrCreateServices()
  await windows.createWindow()

  setTimeout(() => {
    void logMainService.cleanupOldLogs().catch((err) => {
      mainLogger.warn(`cleanupOldLogs failed: ${(err as Error).message}`)
    })
  }, 5000)

  app.on('activate', () => {
    mainLogger.info('app activate')
    if (getOrCreateServices().windows.getWindows().length === 0) {
      void getOrCreateServices().windows.createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  mainLogger.info(`window-all-closed platform=${process.platform}`)
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  mainLogger.info('will-quit')
  userDataService?.dispose()
  acpHostService?.dispose()
  acpTerminalService?.dispose()
  windowMainService?.dispose()
  logMainService.dispose()
})
