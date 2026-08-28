import { app, BrowserWindow, dialog, Menu, protocol } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
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
  localize,
  LogLevel,
  mark,
  normalizePlatform,
  URI,
} from '@universe-editor/platform'
import { version as EXTENSION_API_VERSION } from '@universe-editor/extension-api'
import { initializeMainNls } from '../shared/i18n/bootstrap.js'
import { PerfMarks } from '../shared/perf/marks.js'
import {
  DEEP_LINK_PROTOCOL,
  deepLinkFilePath,
  deepLinkToOpenerTarget,
  isDeepLink,
  parseDeepLink,
  resolveAgentDeepLinkCwd,
  type DeepLinkTarget,
} from '../shared/deepLink.js'
import { installMainProtocolDispatcher } from './ipc/electronProtocol.js'
import { parseFileToOpen } from './cliArgs.js'
import { resolveFromRepo } from './repoPaths.js'
import { getAppVersion } from './appVersion.js'
import { installImageProtocol, IMAGE_SCHEME_PRIVILEGE } from './ipc/imageProtocol.js'
import { APP_SCHEME_PRIVILEGE, installAppProtocolHandler } from './ipc/resourceProtocol.js'
import { LogMainService, ILogMainService } from './services/log/logMainService.js'
import { IBugRecorderService } from '../shared/ipc/bugRecorderService.js'
import type { BugRecordingMainService } from './services/bugRecording/bugRecordingMainService.js'
import { WindowMainService } from './services/window/windowMainService.js'
import { WindowsJumpList } from './services/window/windowsJumpList.js'
import { UpdateMainService } from './services/update/updateMainService.js'
import type { SessionSwitcherMainService } from './services/sessionSwitcher/sessionSwitcherMainService.js'
import type { ConfigLocationMainService } from './services/configLocation/configLocationMainService.js'
import { IConfigLocationService } from '../shared/ipc/configLocationService.js'
import { IAiModelMainService } from '../shared/ipc/aiModelService.js'
import { IAiDebugService } from '../shared/ipc/aiDebugService.js'
import { IRemoteSchemaService } from '../shared/ipc/remoteSchemaService.js'
import { IRemoteStatusService } from '../shared/ipc/remoteStatusService.js'
import type { RemoteStatusMainService } from './services/remoteStatus/remoteStatusMainService.js'
import { IResourceAccessService } from '../shared/ipc/resourceAccessService.js'
import { IEnvironmentSnapshotService } from '../shared/ipc/environmentSnapshotService.js'
import { IFileClipboardService } from '../shared/ipc/fileClipboardService.js'
import { IProcessMonitorService } from '../shared/ipc/processMonitorService.js'
import { IRecentWorkspacesService } from './services/workspace/recentWorkspacesMainService.js'
import { IWatcherProcessService } from '@universe-editor/node-services'
import { IRemoteConnectionService } from './services/remote/remoteConnectionMainService.js'
import {
  IDisposableLeakService,
  IDiagnosticsService,
  IErrorSinkService,
  IIssueReporterService,
  IExchangeRateService,
  IPingService,
  IPerformanceMarksService,
} from '../shared/ipc/services.js'
import { IAcpHostService } from '../shared/ipc/acpHostService.js'
import { AcpHostMainService } from './services/acpHost/acpHostMainService.js'
import { IExtensionHostService } from '../shared/ipc/extensionHostService.js'
import { ExtensionHostMainService } from './services/extensionHost/extensionHostMainService.js'
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
import { ITextSearchMainService } from '@universe-editor/platform'
import { installMainErrorHandlers } from './errors.js'
import {
  installCrashReporter,
  installChildProcessGoneLogging,
  installProcessMetricsLogging,
} from './crashMonitoring.js'
import { ErrorSinkMainService } from './services/telemetry/errorSinkMainService.js'
import { DiagnosticsMainService } from './services/diagnostics/diagnosticsMainService.js'
import {
  armSessionSentinel,
  disarmSessionSentinel,
  readAbnormalExitReport,
  shouldDefaultToRestoreSkip,
  shouldOfferRestoreSkip,
} from './sessionSentinel.js'
import { collectWindowsCrashForensics } from './werForensics.js'
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
    environmentService.formatVersion(productIdentity.productName, getAppVersion(), [
      `Extension API ${EXTENSION_API_VERSION}`,
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
    ]) + '\n',
  )
  app.exit(0)
} else if (environmentService.shouldPrintHelp) {
  if (process.platform === 'win32' && process.stdout.isTTY) process.stdout.write('\x1b[1A\x1b[2K')
  process.stdout.write(
    environmentService.formatHelp(productIdentity.productName, getAppVersion()) + '\n',
  )
  app.exit(0)
}

// Switch productName / userData / AppUserModelId based on dev vs release vs E2E.
// Must run before any `app.getPath('userData')` call (e.g. new LogMainService()).
applyProductIdentity(app, productIdentity)

// Native crashes bypass uncaughtException and the file logger entirely — local
// minidumps are the only way to diagnose a silent quit after the fact.
installCrashReporter()

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
// Structured error sink (errors.jsonl). Constructed beside the log service so
// every failure path below — including main's own uncaughtException — is
// machine-readable, not just a text line. Preset into the DI collection later.
const errorSink = new ErrorSinkMainService(
  {
    sessionDir: logMainService.getSessionDir(),
    sessionId: logMainService.getSessionId(),
    appVersion: getAppVersion(),
    piiPaths: [
      app.getPath('userData'),
      homedir(),
      app.getAppPath(),
      app.getPath('temp'),
      logMainService.getLogRoot(),
    ],
  },
  logMainService,
)
installMainErrorHandlers(mainLogger, (event, error) => errorSink.recordLocal(event, error))

// Route console.* through the log system so ad-hoc console output and
// third-party library noise reach the Console channel (and therefore the
// Output panel) without requiring stdout/DevTools to be open.
const consoleLogger = logMainService.createLogger({ id: 'console', name: 'Console' })
// Node's own process warnings arrive on console.error in the Electron main
// process. Deprecation warnings (e.g. DEP0180 `fs.Stats`, triggered once per
// packaged launch by Electron's asar wrapper — electron/electron#47390) are
// diagnostic noise we cannot act on, not application errors. Demote them so
// they don't trip error-level consumers (ErrorLogAutoRevealContribution would
// pop the Output panel on launch).
const NODE_DEPRECATION_RE = /^\(node:\d+\) \[DEP\d+\] DeprecationWarning:/
const consoleInterceptor = installConsoleInterceptor({
  logger: consoleLogger,
  reclassify: (text, level) =>
    level === LogLevel.Error && NODE_DEPRECATION_RE.test(text) ? LogLevel.Warning : level,
})

installChildProcessGoneLogging(mainLogger, (event, error) => errorSink.recordLocal(event, error))
const processMetricsLogging = installProcessMetricsLogging(logMainService)

const e2eEnabled = environmentService.isE2E
// E2E 静默模式：多 worker 并行冷启动不抢前台焦点。UNIVERSE_E2E_SHOW=1 关闭，恢复有头调试。
const silentE2E = e2eEnabled && !process.env['UNIVERSE_E2E_SHOW']
// Extension-development mode (--extension-development-path): like E2E, each dev
// host is an independent process — joining single-instance negotiation would
// just focus the already-open main instance and drop the dev args on the floor
// (second-instance has no consumer for them). userData is isolated by the
// ExtDev flavor (productPaths), so settings never cross-contaminate.
const extDevEnabled = environmentService.isExtensionDevelopment

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
// with its own userData dir), so it opts out — as does extension-development
// mode (see above).
const hasSingleInstanceLock = e2eEnabled || extDevEnabled || app.requestSingleInstanceLock()
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
        if (silentE2E) targetWin.showInactive()
        else targetWin.focus()
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
 *
 * An agent link is different: its session must run in the workspace rooted at
 * the link's `cwd` (absent → the user's home directory), so it goes to the
 * window whose workspace IS that directory — opening one first when none
 * matches. `openWindowForFolder` owns that match-or-open logic and forwards the
 * link to whichever window it resolves.
 */
function routeDeepLink(target: DeepLinkTarget): void {
  const services = getOrCreateServices()

  if (target.kind === 'agentPrompt') {
    const cwd = resolveAgentDeepLinkCwd(target.cwd, homedir())
    void services.windows.openWindowForFolder(
      URI.file(cwd),
      undefined,
      deepLinkToOpenerTarget({ ...target, cwd }),
    )
    return
  }

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
    if (silentE2E) targetWin.showInactive()
    else targetWin.focus()
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
    ? join(import.meta.dirname, '../../public/icon-dev.ico')
    : undefined

function getOrCreateServices(): { app: ApplicationServices; windows: WindowMainService } {
  if (!applicationServices) {
    mainLogger.info('create application services')
    // Phase two: userData is resolved, so the deployment config file can now be
    // layered in (lowest priority) before services that read it are constructed.
    // The bundled product defaults (galleryUrl etc.) rank below cli/env/user-file:
    // packaged reads resources/product.json (staged by runtime-resources.mjs), dev
    // reads build/product.dev.json (via resolveFromRepo — `pnpm dev` runs
    // `electron .` while `pnpm dev:run` runs a file entry, so getAppPath() differs).
    // E2E stays on the OSS "no marketplace" default.
    const productConfigFile = environmentService.isE2E
      ? undefined
      : app.isPackaged
        ? join(process.resourcesPath, 'product.json')
        : resolveFromRepo('build/product.dev.json')
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
    collection.set(IErrorSinkService, errorSink)
    for (const [id, descriptor] of getSingletonServiceDescriptors()) {
      if (!collection.has(id)) collection.set(id, descriptor)
    }
    rootInstantiation = new InstantiationService(collection)

    applicationServices = rootInstantiation.invokeFunction((accessor) => ({
      ping: accessor.get(IPingService),
      fileSystem: accessor.get(IFileService),
      fileClipboard: accessor.get(IFileClipboardService),
      fileSearch: accessor.get(IFileSearchService),
      textSearch: accessor.get(ITextSearchMainService),
      recentWorkspaces: accessor.get(IRecentWorkspacesService),
      acpHost: accessor.get(IAcpHostService) as AcpHostMainService,
      extensionHost: accessor.get(IExtensionHostService) as ExtensionHostMainService,
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
      aiModel: accessor.get(IAiModelMainService),
      aiDebug: accessor.get(IAiDebugService),
      remoteSchema: accessor.get(IRemoteSchemaService),
      exchangeRate: accessor.get(IExchangeRateService),
      resourceAccess: accessor.get(IResourceAccessService),
      environmentSnapshot: accessor.get(IEnvironmentSnapshotService),
      errorSink: accessor.get(IErrorSinkService) as ErrorSinkMainService,
      diagnostics: accessor.get(IDiagnosticsService) as DiagnosticsMainService,
      bugRecorder: accessor.get(IBugRecorderService) as BugRecordingMainService,
      issueReporter: accessor.get(IIssueReporterService),
      processMonitor: accessor.get(IProcessMonitorService),
      sessionSwitcher: accessor.get(ISessionSwitcherService) as SessionSwitcherMainService,
      configLocation: accessor.get(IConfigLocationService) as ConfigLocationMainService,
      watcherProcess: accessor.get(IWatcherProcessService),
      remoteConnection: accessor.get(IRemoteConnectionService),
      remoteStatus: accessor.get(IRemoteStatusService) as RemoteStatusMainService,
    }))
  }
  if (!windowMainService) {
    windowMainService = new WindowMainService({
      appServices: applicationServices,
      logService: logMainService,
      e2eEnabled,
      silentE2E,
      extensionDevelopment: extDevEnabled,
      rendererDebug: environmentService.rendererDebug,
      ...(appIconPath ? { appIconPath } : {}),
      preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
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
    // Stop Remote Server closes every window scoped to that authority (after
    // their shutdown veto) before tearing the server down.
    applicationServices.remoteStatus.setWindowsParticipant(windows)
    // Screenshots need a live BrowserWindow, which only exists once the window
    // service is up — the recorder is constructed before it.
    applicationServices.bugRecorder.setWindowProvider(() => {
      const id = windows.getFocusedWindowId()
      return id === null ? undefined : windows.getWindowById(id)
    })
    // Windows taskbar Jump List (right-click the pinned icon). Tracks the shared
    // recent-workspaces list; no-op on non-Windows platforms.
    windowsJumpList = new WindowsJumpList(applicationServices.recentWorkspaces, logMainService)
  }
  return { app: applicationServices, windows: windowMainService }
}

installMainProtocolDispatcher()

async function loadMainSettingsText(): Promise<string> {
  // Must read the same file the renderer does: settings.json lives in configDir,
  // which `--config-dir` can relocate away from userData. Reading the wrong path
  // silently drops `workbench.language`, leaving main on the system locale while
  // the window uses the configured one — main-produced strings then arrive in the
  // wrong language.
  const dir = environmentService.configDir || app.getPath('userData')
  try {
    return await fs.readFile(join(dir, 'settings.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

void app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  mark(PerfMarks.mainAppReady)
  mainLogger.info(`app ready locale=${app.getLocale()} e2e=${e2eEnabled}`)

  // A leftover sentinel means the previous session died without reaching
  // will-quit (native crash / external kill). Say so up front, with any crash
  // dumps written since — the difference tells "crashed" apart from "killed".
  const abnormalExit = readAbnormalExitReport(app.getPath('userData'), app.getPath('crashDumps'))
  if (abnormalExit) {
    const lastAlive = new Date(abnormalExit.previousLastAliveAt).toISOString()
    mainLogger.error(
      `previous session ${abnormalExit.previousSessionId} terminated abnormally (no clean-shutdown record); ` +
        `last alive ≈ ${lastAlive}; ` +
        `consecutive=${abnormalExit.consecutiveAbnormalExits}; ` +
        (abnormalExit.crashDumps.length > 0
          ? `crash dumps: ${abnormalExit.crashDumps.join(', ')}`
          : 'no crash dump found — likely killed externally (AV / OOM / task kill)'),
    )
    errorSink.recordLocal(
      'abnormalExit',
      `previous session ${abnormalExit.previousSessionId} terminated abnormally; lastAlive=${lastAlive}; consecutive=${abnormalExit.consecutiveAbnormalExits}; crashDumps=${abnormalExit.crashDumps.length}`,
    )
    // No dump means our own logs hold zero evidence of the cause; the Windows
    // Application event log is the only remaining witness. Crash/hang events
    // (1000/1002) for our exe prove a native death; none at all points at an
    // external TerminateProcess (task kill / AV) or power loss. Fire-and-forget —
    // startup must not wait on wevtutil.
    if (abnormalExit.crashDumps.length === 0 && process.platform === 'win32') {
      const exeName = basename(process.execPath)
      void collectWindowsCrashForensics(exeName, abnormalExit.previousStartedAt)
        .then((events) => {
          if (events.length > 0) {
            for (const line of events) mainLogger.error(`abnormal-exit forensics: ${line}`)
            errorSink.recordLocal('abnormalExitForensics', events.join('; '))
          } else {
            mainLogger.warn(
              'abnormal-exit forensics: no crash/hang/WER event for this exe in the Windows Application log — ' +
                'process was likely terminated externally (task kill / AV) or the machine lost power',
            )
          }
        })
        .catch(() => undefined)
    }
  }
  armSessionSentinel(
    app.getPath('userData'),
    logMainService.getSessionId(),
    abnormalExit?.consecutiveAbnormalExits ?? 0,
  )

  // Drop Electron's built-in application menu on Windows/Linux. Those platforms
  // render a self-drawn title bar (frame:false), so the default menu is invisible
  // yet still registers accelerators — notably Ctrl+R / Ctrl+Shift+R / F5, which
  // fire webContents.reload() directly, bypassing the confirmBeforeShutdown guard
  // and silently killing running sessions. Reload stays available through the
  // ReloadWindowAction command (Ctrl+Alt+R), which honours that guard. macOS is
  // excluded: it depends on the app menu for Cmd+Q/Cmd+C/Cmd+V and other standard
  // roles, so we leave its menu in place (matching VSCode).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  logShutdownTraceIfPresent((msg) => mainLogger.info(msg))
  installImageProtocol()
  installAppProtocolHandler(join(import.meta.dirname, '../renderer'))
  initializeMainNls(await loadMainSettingsText(), app.getLocale())
  const { windows, app: appServices } = getOrCreateServices()
  // Hand the abnormal-exit report to the diagnostics service before the first
  // window can ask for it (consume-once: exactly one window notifies).
  appServices.diagnostics.setAbnormalExitReport(abnormalExit)
  mark(PerfMarks.mainDidCreateServices)

  let sessionList = await loadSession(getDefaultStorage())

  // Two or more abnormal exits in a row with a workspace waiting to be restored
  // usually means the restore itself feeds the crash (e.g. a workspace whose
  // startup walk OOMs the main process). Offer a restore-free start to break
  // the loop before touching that workspace again. Recents keep the folders
  // reachable. Skipped in E2E: a native modal would deadlock the driver.
  if (
    abnormalExit &&
    shouldOfferRestoreSkip(abnormalExit.consecutiveAbnormalExits) &&
    sessionList.some((w) => w.workspace) &&
    !e2eEnabled
  ) {
    const defaultToSkip = shouldDefaultToRestoreSkip(abnormalExit.consecutiveAbnormalExits)
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: [
        localize('crashLoop.restore', 'Start Normally (Restore Workspace)'),
        localize('crashLoop.skip', 'Skip Restore (Open Empty Window)'),
      ],
      defaultId: defaultToSkip ? 1 : 0,
      cancelId: defaultToSkip ? 1 : 0,
      noLink: true,
      title: localize('crashLoop.title', 'Repeated Abnormal Exits'),
      message: localize(
        'crashLoop.message',
        'The application has exited abnormally {count} times in a row.',
        {
          count: String(abnormalExit.consecutiveAbnormalExits),
        },
      ),
      detail: localize(
        'crashLoop.detail',
        'The crashes may have been triggered by the previously opened workspace (for example, a directory containing a huge number of files). You can skip workspace restore this time and start with an empty window for troubleshooting; the previous folders remain reachable from "Recent".',
      ),
    })
    if (response === 1) {
      mainLogger.warn(
        `workspace restore skipped by user after ${abnormalExit.consecutiveAbnormalExits} consecutive abnormal exits`,
      )
      sessionList = []
    } else {
      mainLogger.info(
        `workspace restore kept despite ${abnormalExit.consecutiveAbnormalExits} consecutive abnormal exits`,
      )
    }
  }

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
  // Reaching will-quit at all is what "clean shutdown" means to the sentinel.
  disarmSessionSentinel(app.getPath('userData'))
  windowsJumpList?.dispose()
  windowMainService?.dispose()
  // Disposes every materialized application service (acpHost kills child
  // processes, recentWorkspaces flushes its writes, update tears down, etc.).
  rootInstantiation?.dispose()
  errorSink.dispose()
  // Synchronous: Electron does not wait for promises in will-quit, so a
  // fire-and-forget flush() could be truncated by process exit. flushSync writes
  // the latest in-memory state atomically before we return.
  getDefaultStorage().flushSync()
  consoleInterceptor.dispose()
  processMetricsLogging.dispose()
  logMainService.dispose()
  // Last synchronous mark before the process exits and the NSIS installer takes
  // over: the gap from here to the next launch's process-creation time is the
  // pure install + relaunch cost (see updateShutdownTrace.ts).
  recordShutdownMark('willQuit.end')
})
