import { app, BrowserWindow, protocol } from 'electron'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
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
  isEqualOrParentResource,
  mark,
  normalizePlatform,
  URI,
} from '@universe-editor/platform'
import { initializeMainNls } from '../shared/i18n/bootstrap.js'
import { PerfMarks } from '../shared/perf/marks.js'
import {
  DEEP_LINK_PROTOCOL,
  deepLinkFilePath,
  deepLinkToOpenerTarget,
  isDeepLink,
  parseDeepLink,
  type DeepLinkTarget,
} from '../shared/deepLink.js'
import { installMainProtocolDispatcher } from './ipc/electronProtocol.js'
import { parseFileToOpen } from './cliArgs.js'
import { installImageProtocol, IMAGE_SCHEME_PRIVILEGE } from './ipc/imageProtocol.js'
import { APP_SCHEME_PRIVILEGE, installAppProtocolHandler } from './ipc/resourceProtocol.js'
import { LogMainService, ILogMainService } from './services/log/logMainService.js'
import { WindowMainService } from './services/window/windowMainService.js'
import { WindowsJumpList } from './services/window/windowsJumpList.js'
import { UpdateMainService } from './services/update/updateMainService.js'
import type { SessionSwitcherMainService } from './services/sessionSwitcher/sessionSwitcherMainService.js'
import type { ConfigLocationMainService } from './services/configLocation/configLocationMainService.js'
import { IConfigLocationService } from '../shared/ipc/configLocationService.js'
import { IAiModelMainService } from '../shared/ipc/aiModelService.js'
import { IAiDebugService } from '../shared/ipc/aiDebugService.js'
import { IRemoteSchemaService } from '../shared/ipc/remoteSchemaService.js'
import { IResourceAccessService } from '../shared/ipc/resourceAccessService.js'
import { IEnvironmentSnapshotService } from '../shared/ipc/environmentSnapshotService.js'
import { IRecentWorkspacesService } from './services/workspace/recentWorkspacesMainService.js'
import {
  IDisposableLeakService,
  IExchangeRateService,
  IPingService,
  IPerformanceMarksService,
  IUsageService,
} from '../shared/ipc/services.js'
import { IAcpHostService } from '../shared/ipc/acpHostService.js'
import { IExtensionHostService } from '../shared/ipc/extensionHostService.js'
import { IExtensionManagementService } from '../shared/ipc/extensionManagementService.js'
import { IExtensionGalleryService } from '../shared/ipc/extensionGalleryService.js'
import { IAcpTerminalService } from '../shared/ipc/acpTerminalService.js'
import { IClaudeBinaryService } from '../shared/ipc/claudeBinaryService.js'
import { IClaudeConfigService } from '../shared/ipc/claudeConfigService.js'
import { ICodexBinaryService } from '../shared/ipc/codexBinaryService.js'
import { ICodexConfigService } from '../shared/ipc/codexConfigService.js'
import { IUpdateService } from '../shared/ipc/updateService.js'
import { IReleaseNotesService } from '../shared/ipc/releaseNotesService.js'
import { IDocsService } from '../shared/ipc/docsService.js'
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
import {
  clearShutdownTrace,
  readShutdownTrace,
  recordShutdownMark,
} from './services/update/updateShutdownTrace.js'
import type { ApplicationServices } from './window/scopedServicesFactory.js'
// Side-effect: registers all application-singleton main services with registerSingleton.
import './services/main-services.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Stamp the OS process-creation time as the earliest mark (before mainDidStart)
// so the pre-JS gap — spawn → first line here — shows up in the startup timeline.
// getCreationTime() returns epoch ms, the same base as the perf polyfill's Date.now().
const _processCreatedAt = process.getCreationTime()
if (_processCreatedAt !== null) {
  mark(PerfMarks.mainProcessCreated, { startTime: _processCreatedAt })
}

mark(PerfMarks.mainDidStart)

// Post-update first launch: fold the previous process's cross-process shutdown
// trace (click → will-quit.end, in epoch ms) into a single timeline and expose
// the otherwise-invisible NSIS-install + relaunch gap (will-quit.end → this
// process's OS creation time). Logged once, then the trace file is deleted.
function logShutdownTraceIfPresent(log: (msg: string) => void): void {
  const entries = readShutdownTrace()
  if (!entries) return
  const parts: string[] = []
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]
    const cur = entries[i]
    if (!prev || !cur) continue
    parts.push(`${prev.label}→${cur.label}:${Math.round(cur.at - prev.at)}ms`)
  }
  const last = entries[entries.length - 1]
  if (last && _processCreatedAt !== null) {
    // The dominant post-update cost: from the old process's final synchronous
    // mark to the new process being created by the OS (NSIS overwrite + AV
    // first-scan of the freshly written exe/asar + relaunch).
    parts.push(`${last.label}→processCreated:${Math.round(_processCreatedAt - last.at)}ms`)
  }
  const first = entries[0]
  const total =
    first && _processCreatedAt !== null ? Math.round(_processCreatedAt - first.at) : undefined
  log(
    `update shutdown trace${total !== undefined ? ` clickToRelaunch=${total}ms` : ''} [${parts.join(', ')}]`,
  )
  clearShutdownTrace()
}

// Must run before app.whenReady(): Electron only accepts privileged-scheme
// registration during this window, and ONLY ONCE — every custom scheme must be
// registered in this single call, or a later call overwrites the earlier list.
protocol.registerSchemesAsPrivileged([IMAGE_SCHEME_PRIVILEGE, APP_SCHEME_PRIVILEGE])

// Single entry point for CLI args / env vars / deployment config. Must be built
// before any app.getPath('userData') call (e.g. new LogMainService()). The file
// source is appended later (resolveFileConfig), once userData is resolved.
const environmentService = new EnvironmentMainService({
  argv: process.argv,
  env: process.env,
  isDev: import.meta.env.DEV,
})

// A `universe-editor://` deep link is passed just like a file path (as a plain
// argv entry on Windows / Linux). Pick it out separately so it routes through
// the opener rather than being treated as a file to open.
function parseDeepLinkArg(argv: readonly string[]): DeepLinkTarget | undefined {
  const raw = argv.find((a) => isDeepLink(a))
  return raw ? parseDeepLink(raw) : undefined
}

const startupPath = parseFileToOpen(process.argv, app.isPackaged)
const startupDeepLink = parseDeepLinkArg(process.argv)

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

// Register as the OS handler for `universe-editor://` deep links. On Windows the
// packaged exe path + args must be passed explicitly so a protocol launch
// re-enters this binary; on macOS the association is declared in the plist and
// links arrive via the `open-url` event. E2E opts out (isolated instances must
// not fight over the OS-wide association).
if (!environmentService.isE2E) {
  if (process.platform === 'win32' && !app.isPackaged) {
    // Dev: argv[0]=electron, argv[1]=main script. Register electron.exe with the
    // script path so `electron main.js universe-editor://…` round-trips.
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [
      resolve(process.argv[1] ?? ''),
    ])
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL)
  }
}

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
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const deepLink = parseDeepLinkArg(argv)
    if (deepLink) {
      routeDeepLink(deepLink)
      return
    }
    const argPath = parseFileToOpen(argv, app.isPackaged)
    const services = getOrCreateServices()

    void (async () => {
      // Resolve relative paths (e.g. ".") against the second instance's working
      // directory, not this (first) process's cwd.
      const resolvedPath = argPath ? resolve(workingDirectory, argPath) : undefined

      if (resolvedPath) {
        const stat = await fs.stat(resolvedPath).catch(() => null)
        if (stat?.isDirectory()) {
          await services.windows.openWindowForFolder(URI.file(resolvedPath))
          return
        }
      } else {
        // A bare re-launch (e.g. clicking the app icon while already running)
        // carries no file/folder. Match VSCode and open a fresh empty window
        // instead of only focusing the existing one.
        await services.windows.createWindow({})
        return
      }

      // Route the file to the window whose workspace contains it; else first window.
      let targetWin: BrowserWindow | undefined
      if (resolvedPath) {
        const fileUri = URI.file(resolvedPath)
        for (const info of services.windows.getOpenWindowInfos()) {
          const folder = info.folder
          if (folder) {
            const revived = URI.revive(folder)
            if (!revived) continue
            if (isEqualOrParentResource(fileUri, revived, normalizePlatform(process.platform))) {
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
        if (resolvedPath) targetWin.webContents.send('ue:open-file', resolvedPath)
      } else {
        void services.windows.createWindow(resolvedPath ? { fileToOpen: resolvedPath } : {})
      }
    })()
  })
}

// macOS delivers `universe-editor://` links through this event rather than argv.
// May fire before app.whenReady() (cold launch from a link), so routeDeepLink
// tolerates a not-yet-created window by opening one.
app.on('open-url', (event, url) => {
  if (!isDeepLink(url)) return
  event.preventDefault()
  const target = parseDeepLink(url)
  if (target) routeDeepLink(target)
})

/**
 * Route a parsed deep link to a window and forward it to that window's renderer,
 * which turns it back into an IOpenerService.open call. A file link prefers the
 * window whose workspace contains the file; a command link goes to the focused
 * (or first) window. With no window open yet, one is created.
 */
function routeDeepLink(target: DeepLinkTarget): void {
  const services = getOrCreateServices()
  const filePath = deepLinkFilePath(target)

  let targetWin: BrowserWindow | undefined
  if (filePath) {
    const fileUri = URI.file(filePath)
    for (const info of services.windows.getOpenWindowInfos()) {
      const folder = info.folder ? URI.revive(info.folder) : undefined
      if (folder && isEqualOrParentResource(fileUri, folder, normalizePlatform(process.platform))) {
        targetWin = services.windows.getWindowById(info.id)
        break
      }
    }
  }
  if (!targetWin) targetWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

  if (targetWin) {
    if (targetWin.isMinimized()) targetWin.restore()
    targetWin.focus()
    targetWin.webContents.send('ue:open-uri', deepLinkToOpenerTarget(target))
  } else {
    void services.windows.createWindow({ deepLink: deepLinkToOpenerTarget(target) })
  }
}

// Application-singleton services — shared across all windows, owned by the root
// DI container. The container disposes every materialized service on will-quit.
let rootInstantiation: InstantiationService | null = null
let applicationServices: ApplicationServices | null = null
let windowMainService: WindowMainService | null = null
let windowsJumpList: WindowsJumpList | null = null
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
    // The bundled product defaults (galleryUrl etc.) rank below cli/env/user-file:
    // packaged reads resources/product.json (staged by runtime-resources.mjs), dev
    // reads build/product.dev.json. E2E stays on the OSS "no marketplace" default.
    const productConfigFile = environmentService.isE2E
      ? undefined
      : app.isPackaged
        ? join(process.resourcesPath, 'product.json')
        : join(app.getAppPath(), 'build', 'product.dev.json')
    environmentService.resolveFileConfig(app.getPath('userData'), productConfigFile)

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
      extensionManagement: accessor.get(IExtensionManagementService),
      extensionGallery: accessor.get(IExtensionGalleryService),
      acpTerminal: accessor.get(IAcpTerminalService),
      claudeBinary: accessor.get(IClaudeBinaryService),
      claudeConfig: accessor.get(IClaudeConfigService),
      codexBinary: accessor.get(ICodexBinaryService),
      codexConfig: accessor.get(ICodexConfigService),
      disposableLeak: accessor.get(IDisposableLeakService),
      update: accessor.get(IUpdateService) as UpdateMainService,
      releaseNotes: accessor.get(IReleaseNotesService),
      docs: accessor.get(IDocsService),
      performance: accessor.get(IPerformanceMarksService),
      usage: accessor.get(IUsageService),
      aiModel: accessor.get(IAiModelMainService),
      aiDebug: accessor.get(IAiDebugService),
      remoteSchema: accessor.get(IRemoteSchemaService),
      exchangeRate: accessor.get(IExchangeRateService),
      resourceAccess: accessor.get(IResourceAccessService),
      environmentSnapshot: accessor.get(IEnvironmentSnapshotService),
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
      getConfigDir: () => applicationServices!.configLocation.currentDir,
    })
    // Gate quitAndInstall behind the same running-session veto a normal quit runs.
    // Without this, electron-updater spawns the installer before before-quit can
    // veto, so a cancelled confirm still installs. confirmQuit polls every window.
    const windows = windowMainService
    applicationServices.update.setQuitConfirmer((requestingWindowId) =>
      windows.confirmQuit(requestingWindowId),
    )
    // Windows taskbar Jump List (right-click the pinned icon). Tracks the shared
    // recent-workspaces list; no-op on non-Windows platforms.
    windowsJumpList = new WindowsJumpList(applicationServices.recentWorkspaces, logMainService)
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
  logShutdownTraceIfPresent((msg) => mainLogger.info(msg))
  installImageProtocol()
  installAppProtocolHandler(join(__dirname, '../renderer'))
  initializeMainNls(await loadMainSettingsText(), app.getLocale())
  const { windows } = getOrCreateServices()
  mark(PerfMarks.mainDidCreateServices)

  const sessionList = await loadSession(getDefaultStorage())
  let startupFolderUri: URI | undefined
  let startupFilePath: string | undefined
  if (startupPath) {
    const stat = await fs.stat(startupPath).catch(() => null)
    if (stat?.isDirectory()) {
      startupFolderUri = URI.file(resolve(startupPath))
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

  // A `universe-editor://` link that cold-launched the app: the session is now
  // restored (windows exist), so route it to the best-matching one.
  if (startupDeepLink) routeDeepLink(startupDeepLink)

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
    recordShutdownMark('beforeQuit.proceed')
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
    // Gracefully stop the extension hosts and AWAIT the stdin-EOF shutdown
    // cascade (host → deactivate typescript ext → CLI reaps tsserver). will-quit
    // is synchronous and can only hard-kill, which orphans a slow-starting
    // tsserver; draining the cascade here reaps the whole tree cleanly.
    await applicationServices?.extensionHost.stopAll().catch(() => undefined)
    app.quit()
  })()
})

app.on('will-quit', () => {
  mainLogger.info('will-quit')
  recordShutdownMark('willQuit.start')
  windowsJumpList?.dispose()
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
  // Last synchronous mark before the process exits and the NSIS installer takes
  // over: the gap from here to the next launch's process-creation time is the
  // pure install + relaunch cost (see updateShutdownTrace.ts).
  recordShutdownMark('willQuit.end')
})
