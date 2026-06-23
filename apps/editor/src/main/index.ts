import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DisposableTracker,
  setDisposableTracker,
  installConsoleInterceptor,
  getOriginalConsole,
  InstantiationService,
  ServiceCollection,
  getSingletonServiceDescriptors,
  ILoggerService,
  IFileSearchService,
  IFileService,
  mark,
  URI,
} from '@universe-editor/platform'
import { initializeMainNls } from '../shared/i18n/bootstrap.js'
import { PerfMarks } from '../shared/perf/marks.js'
import { installMainProtocolDispatcher } from './ipc/electronProtocol.js'
import { LogMainService, ILogMainService } from './services/log/logMainService.js'
import { WindowMainService } from './services/window/windowMainService.js'
import type { SessionSwitcherMainService } from './services/sessionSwitcher/sessionSwitcherMainService.js'
import type { ConfigLocationMainService } from './services/configLocation/configLocationMainService.js'
import { IConfigLocationService } from '../shared/ipc/configLocationService.js'
import { IAiModelMainService } from '../shared/ipc/aiModelService.js'
import { IAiDebugService } from '../shared/ipc/aiDebugService.js'
import { IRemoteSchemaService } from '../shared/ipc/remoteSchemaService.js'
import { IRecentWorkspacesService } from './services/workspace/recentWorkspacesMainService.js'
import {
  IDisposableLeakService,
  IPingService,
  IPerformanceMarksService,
  IUsageService,
} from '../shared/ipc/services.js'
import { IAcpHostService } from '../shared/ipc/acpHostService.js'
import { IExtensionHostService } from '../shared/ipc/extensionHostService.js'
import { IAcpTerminalService } from '../shared/ipc/acpTerminalService.js'
import { IClaudeBinaryService } from '../shared/ipc/claudeBinaryService.js'
import { ICodexBinaryService } from '../shared/ipc/codexBinaryService.js'
import { IUpdateService } from '../shared/ipc/updateService.js'
import { IReleaseNotesService } from '../shared/ipc/releaseNotesService.js'
import { ISessionSwitcherService } from '../shared/ipc/sessionSwitcher.js'
import { ITextSearchMainService } from '../shared/ipc/textSearchService.js'
import { installMainErrorHandlers } from './errors.js'
import { applyProductIdentity, resolveProductIdentity } from './productPaths.js'
import {
  EnvironmentMainService,
  IEnvironmentMainService,
} from './environment/environmentMainService.js'
import { getDefaultStorage, IMainStorageService } from './storage.js'
import { loadSession } from './windowsSession.js'
import type { ApplicationServices } from './window/scopedServicesFactory.js'
// Side-effect: registers all application-singleton main services with registerSingleton.
import './services/main-services.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

mark(PerfMarks.mainDidStart)

// Single entry point for CLI args / env vars / deployment config. Must be built
// before any app.getPath('userData') call (e.g. new LogMainService()). The file
// source is appended later (resolveFileConfig), once userData is resolved.
const environmentService = new EnvironmentMainService({
  argv: process.argv,
  env: process.env,
  isDev: import.meta.env.DEV,
})

// Extract the first positional argument (file or directory) to open at startup.
// Windows file associations pass the file path as a plain argument.
// Packaged: argv[0]=exe, argv[1+]=user args
// Dev:      argv[0]=electron, argv[1]=main script, argv[2+]=user args
function parseFileToOpen(argv: readonly string[], isPackaged: boolean): string | undefined {
  return argv.slice(isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && a.length > 0)
}
const startupPath = parseFileToOpen(process.argv, app.isPackaged)

// Resolve product identity once (pure): reused for the --version/--help banner
// and for applyProductIdentity below.
const productIdentity = resolveProductIdentity(environmentService.toResolveEnv())

// CLI commands that print and exit. Handle before any setup (console interceptor,
// single-instance lock) so output reaches the real stdout and a second launch with
// --help/--version isn't forwarded to a running instance.
if (environmentService.shouldPrintVersion) {
  // Electron (GUI subsystem) outputs \r\n when attaching to the parent console on Windows,
  // leaving a blank line before our output. Move up one line and clear it.
  if (process.platform === 'win32' && process.stdout.isTTY) process.stdout.write('\x1b[1A\x1b[2K')
  process.stdout.write(
    environmentService.formatVersion(productIdentity.productName, app.getVersion(), [
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
    ]) + '\n',
  )
  app.exit(0)
} else if (environmentService.shouldPrintHelp) {
  if (process.platform === 'win32' && process.stdout.isTTY) process.stdout.write('\x1b[1A\x1b[2K')
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

// E2E：Playwright 多 worker 会并发开多个互相遮挡的窗口；Chromium 对被遮挡/
// 后台窗口节流计时器与渲染，使 3 秒通知自动已读等时序相关 UI 偶发失败。
// 关闭全部后台节流，让 E2E 时序与前台窗口一致。必须在 app.whenReady() 之前。
if (e2eEnabled) {
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
}

// Single-instance lock: a second launch focuses the existing window instead of
// starting a rival process. Required for the auto-update restart-to-install flow
// (quitAndInstall relaunches the app). E2E spawns many isolated instances (each
// with its own userData dir), so it opts out.
const hasSingleInstanceLock = e2eEnabled || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const argPath = parseFileToOpen(argv, app.isPackaged)
    const services = getOrCreateServices()

    void (async () => {
      if (argPath) {
        const stat = await fs.stat(argPath).catch(() => null)
        if (stat?.isDirectory()) {
          await services.windows.openWindowForFolder(URI.file(argPath))
          return
        }
      }

      // Route the file to the window whose workspace contains it; else first window.
      let targetWin: BrowserWindow | undefined
      if (argPath) {
        const fileNorm = argPath.toLowerCase().replace(/\\/g, '/')
        for (const info of services.windows.getOpenWindowInfos()) {
          const folder = info.folder
          if (folder) {
            const revived = URI.revive(folder)
            if (!revived) continue
            const folderNorm = revived.fsPath.toLowerCase().replace(/\\/g, '/') + '/'
            if (fileNorm.startsWith(folderNorm)) {
              targetWin = services.windows.getWindowById(info.id)
              break
            }
          }
        }
      }
      if (!targetWin) targetWin = BrowserWindow.getAllWindows()[0]

      if (targetWin) {
        if (targetWin.isMinimized()) targetWin.restore()
        targetWin.focus()
        if (argPath) targetWin.webContents.send('ue:open-file', argPath)
      } else {
        void services.windows.createWindow(argPath ? { fileToOpen: argPath } : {})
      }
    })()
  })
}

// Application-singleton services — shared across all windows, owned by the root
// DI container. The container disposes every materialized service on will-quit.
let rootInstantiation: InstantiationService | null = null
let applicationServices: ApplicationServices | null = null
let windowMainService: WindowMainService | null = null
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
    // Phase two: userData is resolved, so the deployment config file can now be
    // layered in (lowest priority) before services that read it are constructed.
    environmentService.resolveFileConfig(app.getPath('userData'))

    // Root DI container. Preset instances (constructed before the container,
    // because they resolve userData / log paths) + the declaratively-registered
    // singletons feed the collection; the container then materializes services on
    // demand, injecting @ILoggerService etc.
    const collection = new ServiceCollection()
    collection.set(ILoggerService, logMainService)
    collection.set(ILogMainService, logMainService)
    collection.set(IEnvironmentMainService, environmentService)
    collection.set(IMainStorageService, getDefaultStorage())
    for (const [id, descriptor] of getSingletonServiceDescriptors()) {
      if (!collection.has(id)) collection.set(id, descriptor)
    }
    rootInstantiation = new InstantiationService(collection)

    applicationServices = rootInstantiation.invokeFunction((accessor) => ({
      ping: accessor.get(IPingService),
      fileSystem: accessor.get(IFileService),
      fileSearch: accessor.get(IFileSearchService),
      textSearch: accessor.get(ITextSearchMainService),
      recentWorkspaces: accessor.get(IRecentWorkspacesService),
      acpHost: accessor.get(IAcpHostService),
      extensionHost: accessor.get(IExtensionHostService),
      acpTerminal: accessor.get(IAcpTerminalService),
      claudeBinary: accessor.get(IClaudeBinaryService),
      codexBinary: accessor.get(ICodexBinaryService),
      disposableLeak: accessor.get(IDisposableLeakService),
      update: accessor.get(IUpdateService),
      releaseNotes: accessor.get(IReleaseNotesService),
      performance: accessor.get(IPerformanceMarksService),
      usage: accessor.get(IUsageService),
      aiModel: accessor.get(IAiModelMainService),
      aiDebug: accessor.get(IAiDebugService),
      remoteSchema: accessor.get(IRemoteSchemaService),
      sessionSwitcher: accessor.get(ISessionSwitcherService) as SessionSwitcherMainService,
      configLocation: accessor.get(IConfigLocationService) as ConfigLocationMainService,
    }))
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
      getConfigDir: () => applicationServices!.configLocation.currentDir,
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
  mark(PerfMarks.mainAppReady)
  mainLogger.info(`app ready locale=${app.getLocale()} e2e=${e2eEnabled}`)
  initializeMainNls(await loadMainSettingsText(), app.getLocale())
  const { windows } = getOrCreateServices()
  mark(PerfMarks.mainDidCreateServices)

  const sessionList = await loadSession(getDefaultStorage())
  let startupFolderUri: URI | undefined
  let startupFilePath: string | undefined
  if (startupPath) {
    const stat = await fs.stat(startupPath).catch(() => null)
    if (stat?.isDirectory()) {
      startupFolderUri = URI.file(startupPath)
    } else {
      startupFilePath = startupPath
    }
  }

  if (startupFolderUri) {
    if (sessionList.length > 0) await windows.restoreSession(sessionList)
    await windows.openWindowForFolder(startupFolderUri)
  } else {
    await windows.restoreSession(sessionList, startupFilePath)
  }

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

app.on('before-quit', (e) => {
  // Already cleared (or no windows yet): let the quit proceed and snapshot the
  // open-windows session before windows start closing, so the per-window close
  // handlers don't shrink the persisted list to empty.
  if (windowMainService?.isQuitConfirmed() || !windowMainService) {
    mainLogger.info('before-quit proceed')
    void windowMainService?.captureSessionForQuit()
    return
  }
  // First pass: ask every window's renderer before committing to the quit, so
  // running sessions can be guarded. Veto cancels the quit entirely.
  mainLogger.info('before-quit confirm')
  e.preventDefault()
  void (async () => {
    const ok = await windowMainService.confirmQuit()
    if (!ok) {
      mainLogger.info('quit vetoed by renderer')
      return
    }
    // Persist AND drain the write to disk before quitting. will-quit cannot await
    // async work, so the durable write must complete here; flushSync there is a
    // last-resort backstop.
    await windowMainService.captureSessionForQuit()
    await getDefaultStorage().flush()
    app.quit()
  })()
})

app.on('will-quit', () => {
  mainLogger.info('will-quit')
  windowMainService?.dispose()
  // Disposes every materialized application service (acpHost kills child
  // processes, recentWorkspaces flushes its writes, update tears down, etc.).
  rootInstantiation?.dispose()
  // Synchronous: Electron does not wait for promises in will-quit, so a
  // fire-and-forget flush() could be truncated by process exit. flushSync writes
  // the latest in-memory state atomically before we return.
  getDefaultStorage().flushSync()
  consoleInterceptor.dispose()
  logMainService.dispose()
})
