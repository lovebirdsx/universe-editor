import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DisposableTracker,
  setDisposableTracker,
  installConsoleInterceptor,
  getOriginalConsole,
} from '@universe-editor/platform'
import { initializeMainNls } from '../shared/i18n/bootstrap.js'
import { installMainProtocolDispatcher } from './ipc/electronProtocol.js'
import { MainPingService } from './services/ping/pingMainService.js'
import { FileSystemMainService } from './services/files/fileSystemMainService.js'
import { FileWatcherMainService } from './services/fileWatcher/fileWatcherMainService.js'
import { RecentWorkspacesMainService } from './services/workspace/recentWorkspacesMainService.js'
import { LogMainService } from './services/log/logMainService.js'
import { LogFilesMainService } from './services/log/logFilesMainService.js'
import { WindowMainService } from './services/window/windowMainService.js'
import { AcpHostMainService } from './services/acpHost/acpHostMainService.js'
import { AcpTerminalMainService } from './services/acpTerminal/acpTerminalMainService.js'
import { ClaudeBinaryMainService } from './services/claudeBinary/claudeBinaryMainService.js'
import { DisposableLeakMainService } from './services/disposableLeak/disposableLeakMainService.js'
import { UpdateMainService } from './services/update/updateMainService.js'
import { installMainErrorHandlers } from './errors.js'
import { applyProductIdentity, resolveProductIdentity } from './productPaths.js'
import { EnvironmentMainService } from './environment/environmentMainService.js'
import { getDefaultStorage } from './storage.js'
import { loadSession } from './windowsSession.js'
import type { ApplicationServices } from './window/scopedServicesFactory.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Single entry point for CLI args / env vars / deployment config. Must be built
// before any app.getPath('userData') call (e.g. new LogMainService()). The file
// source is appended later (resolveFileConfig), once userData is resolved.
const environmentService = new EnvironmentMainService({
  argv: process.argv,
  env: process.env,
  isDev: import.meta.env.DEV,
})

// Resolve product identity once (pure): reused for the --version/--help banner
// and for applyProductIdentity below.
const productIdentity = resolveProductIdentity(environmentService.toResolveEnv())

// CLI commands that print and exit. Handle before any setup (console interceptor,
// single-instance lock) so output reaches the real stdout and a second launch with
// --help/--version isn't forwarded to a running instance.
if (environmentService.shouldPrintVersion) {
  process.stdout.write(
    environmentService.formatVersion(productIdentity.productName, app.getVersion(), [
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
    ]) + '\n',
  )
  app.exit(0)
} else if (environmentService.shouldPrintHelp) {
  process.stdout.write(
    environmentService.formatHelp(productIdentity.productName, app.getVersion()) + '\n',
  )
  app.exit(0)
}

// Switch productName / userData / AppUserModelId based on dev vs release vs E2E.
// Must run before any `app.getPath('userData')` call (e.g. new LogMainService()).
applyProductIdentity(app, productIdentity)

// Dev-only: track Disposable leaks. Report on process exit.
if (import.meta.env.DEV) {
  const tracker = new DisposableTracker()
  setDisposableTracker(tracker)
  process.on('exit', () => {
    const report = tracker.computeLeakingDisposables()
    if (report) {
      getOriginalConsole().warn(
        `[main] ${report.leaks.length} Disposable leak(s) detected:\n${report.details}`,
      )
    }
  })
}

// Dev-only: enable Chromium remote debugging port so VS Code's Chrome debugger
// can attach to the renderer process. Activated via VSCODE_RENDERER_DEBUG=1
// (set by the VS Code task in .vscode/tasks.json). Must be called before app.whenReady().
if (import.meta.env.DEV && environmentService.rendererDebug) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// Install global error handlers as early as possible (before any async work).
const logMainService = new LogMainService()
const mainLogger = logMainService.createLogger({ id: 'main', name: 'Main' })
installMainErrorHandlers(mainLogger)

// Route console.* through the log system so ad-hoc console output and
// third-party library noise reach the Console channel (and therefore the
// Output panel) without requiring stdout/DevTools to be open.
const consoleLogger = logMainService.createLogger({ id: 'console', name: 'Console' })
const consoleInterceptor = installConsoleInterceptor({ logger: consoleLogger })

const e2eEnabled = environmentService.isE2E

// Single-instance lock: a second launch focuses the existing window instead of
// starting a rival process. Required for the auto-update restart-to-install flow
// (quitAndInstall relaunches the app). E2E spawns many isolated instances (each
// with its own userData dir), so it opts out.
const hasSingleInstanceLock = e2eEnabled || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    } else {
      void getOrCreateServices().windows.createWindow({})
    }
  })
}

// Application-singleton services — shared across all windows.
let applicationServices: ApplicationServices | null = null
let recentWorkspacesService: RecentWorkspacesMainService | null = null
let acpHostService: AcpHostMainService | null = null
let acpTerminalService: AcpTerminalMainService | null = null
let windowMainService: WindowMainService | null = null
let claudeBinaryService: ClaudeBinaryMainService | null = null
let updateService: UpdateMainService | null = null
// 打包后的 Windows 任务栏 / Alt+Tab 图标来自可执行文件内嵌图标（electron-builder `win.icon`）。
// 给 BrowserWindow.icon 传 asar 内路径会用一个加载失败的空图标把它覆盖成默认 Electron 图标，
// 所以仅在 dev（运行的是通用 electron.exe）下显式设置，并使用专属的 dev 图标以区分发布版。
const appIconPath =
  process.platform === 'win32' && !app.isPackaged
    ? join(__dirname, '../../public/icon-dev.ico')
    : undefined

function getOrCreateServices(): { app: ApplicationServices; windows: WindowMainService } {
  if (!applicationServices) {
    mainLogger.info('create application services')
    const recentWorkspaces = new RecentWorkspacesMainService(
      getDefaultStorage(),
      logMainService.createLogger({ id: 'workspace', name: 'Workspace' }),
    )
    recentWorkspacesService = recentWorkspaces
    const acpHost = new AcpHostMainService(
      logMainService.createLogger({ id: 'acpHost', name: 'ACP Host' }),
    )
    acpHostService = acpHost
    const acpTerminal = new AcpTerminalMainService(
      logMainService.createLogger({ id: 'acpTerminal', name: 'ACP Terminal' }),
    )
    acpTerminalService = acpTerminal
    claudeBinaryService = new ClaudeBinaryMainService(
      logMainService.createLogger({ id: 'claudeBinary', name: 'Claude Binary' }),
    )
    // Phase two: userData is resolved, so the deployment config file can now be
    // layered in (lowest priority) before services that read it are constructed.
    environmentService.resolveFileConfig(app.getPath('userData'))
    updateService = new UpdateMainService(
      logMainService.createLogger({ id: 'update', name: 'Update' }),
      environmentService,
    )
    applicationServices = {
      ping: new MainPingService(),
      fileSystem: new FileSystemMainService(
        logMainService.createLogger({ id: 'fileSystem', name: 'File System' }),
      ),
      fileWatcher: new FileWatcherMainService(
        logMainService.createLogger({ id: 'fileWatcher', name: 'File Watcher' }),
      ),
      recentWorkspaces,
      logFiles: new LogFilesMainService(logMainService),
      acpHost,
      acpTerminal,
      claudeBinary: claudeBinaryService,
      disposableLeak: new DisposableLeakMainService(),
      update: updateService,
    }
  }
  if (!windowMainService) {
    windowMainService = new WindowMainService({
      appServices: applicationServices,
      logService: logMainService,
      e2eEnabled,
      rendererDebug: environmentService.rendererDebug,
      ...(appIconPath ? { appIconPath } : {}),
      preloadPath: join(__dirname, '../preload/index.cjs'),
      rendererUrl: environmentService.rendererUrl,
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
  if (!hasSingleInstanceLock) return
  mainLogger.info(`app ready locale=${app.getLocale()} e2e=${e2eEnabled}`)
  initializeMainNls(await loadMainSettingsText(), app.getLocale())
  const { windows } = getOrCreateServices()
  await windows.restoreSession(await loadSession(getDefaultStorage()))

  setTimeout(() => {
    void logMainService.cleanupOldLogs(20).catch((err) => {
      mainLogger.warn(`cleanupOldLogs failed: ${(err as Error).message}`)
    })
  }, 5000)

  app.on('activate', () => {
    mainLogger.info('app activate')
    if (getOrCreateServices().windows.getWindows().length === 0) {
      void getOrCreateServices().windows.createWindow({})
    }
  })
})

app.on('window-all-closed', () => {
  mainLogger.info(`window-all-closed platform=${process.platform}`)
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  mainLogger.info('before-quit')
  // Snapshot the open-windows session before windows start closing, so the
  // per-window close handlers don't shrink the persisted list to empty.
  windowMainService?.captureSessionForQuit()
})

app.on('will-quit', () => {
  mainLogger.info('will-quit')
  windowMainService?.dispose()
  recentWorkspacesService?.dispose()
  acpHostService?.dispose()
  acpTerminalService?.dispose()
  claudeBinaryService?.dispose()
  updateService?.dispose()
  void getDefaultStorage().flush()
  consoleInterceptor.dispose()
  logMainService.dispose()
})
