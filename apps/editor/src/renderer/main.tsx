import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ServiceCollection,
  InstantiationService,
  LifecycleService,
  LifecyclePhase,
  ILifecycleService,
  ICommandService,
  IContextKeyService,
  ContextKeyService,
  IDialogService,
  IEditorResolverService,
  IEditorService,
  IEditorGroupsService,
  IFileService,
  IFileWatcherService,
  IStatusBarService,
  ITextSearchService,
  IViewsService,
  IQuickInputService,
  IOutputService,
  ILayoutService,
  IHostService,
  IIpcService,
  IStorageService,
  IConfigurationService,
  IUserDataFilesService,
  IWorkspaceService,
  type IWorkspaceServiceWire,
  ConfigurationService,
  ContributionService,
  IContributionService,
  ILoggerService,
  INotificationService,
  IProgressService,
  ITelemetryService,
  NoopTelemetryService,
  Severity,
  ProxyChannel,
  DisposableTracker,
  localize,
  setDisposableTracker,
  setErrorTelemetryHook,
  setUnexpectedErrorHandler,
  normalizePlatform,
} from '@universe-editor/platform'
import { ServiceChannels } from '../shared/ipc/channelNames.js'
import { ILogChannelService, ILogFilesService, IPingService } from '../shared/ipc/services.js'
import { IAcpHostService } from '../shared/ipc/acpHostService.js'
import { IAcpTerminalService } from '../shared/ipc/acpTerminalService.js'
import { initializeRendererNls } from '../shared/i18n/bootstrap.js'
import { createRendererIpcService } from './ipc/bootstrap.js'
import { installRendererErrorHandlers } from './errors.js'
import { RendererLoggerService } from './services/log/rendererLoggerService.js'
import { CommandService } from './services/command/CommandService.js'
import { EditorService } from './services/editor/EditorService.js'
import { EditorGroupsService } from './services/editor/EditorGroupsService.js'
import { StatusBarService } from './services/statusbar/StatusBarService.js'
import { ViewsService } from './services/views/ViewsService.js'
import { QuickInputService } from './services/quickInput/QuickInputService.js'
import { OutputService } from './services/output/OutputService.js'
import { LayoutService } from './services/layout/LayoutService.js'
import { RendererDialogService } from './services/dialog/RendererDialogService.js'
import { NotificationService } from './services/notification/NotificationService.js'
import { ProgressService } from './services/progress/ProgressService.js'
import { UserSettingsSync } from './services/configuration/UserSettingsSync.js'
import {
  UserKeybindingsService,
  IUserKeybindingsService,
} from './services/keybindings/UserKeybindingsService.js'
import { RendererWorkspaceService } from './services/workspace/RendererWorkspaceService.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from './services/explorer/ExplorerTreeService.js'
import { TextSearchService } from './services/search/TextSearchService.js'
import { ALL_PART_CTORS } from './workbench/parts/index.js'
import { setMonacoLoaderLogger } from './workbench/editor/monaco/MonacoLoader.js'
import {
  IRecentFilesService,
  RecentFilesService,
} from './services/recentFiles/recentFilesService.js'
import {
  IRecentEditorsService,
  RecentEditorsService,
} from './services/editor/RecentEditorsService.js'
import { EditorResolverService } from './services/editor/EditorResolverService.js'
import { AcpAgentRegistry, IAcpAgentRegistry } from './services/acp/acpAgentRegistry.js'
import { AcpPermissionHandler, IAcpPermissionHandler } from './services/acp/acpPermissionHandler.js'
import { AcpPathPolicy, IAcpPathPolicy } from './services/acp/acpPathPolicy.js'
import { AcpClientService, IAcpClientService } from './services/acp/acpClientService.js'
import {
  AcpSessionHistoryService,
  IAcpSessionHistoryService,
} from './services/acp/acpSessionHistory.js'
import { AcpSessionService, IAcpSessionService } from './services/acp/acpSessionService.js'
import './workbench.css'
import { installE2EProbeIfEnabled } from './e2e/probe.js'

// Install global error handlers before any async work.
setUnexpectedErrorHandler((e) => console.error('[renderer] unexpected error:', e))
installRendererErrorHandlers()

async function bootstrapWorkbench(): Promise<void> {
  // Dev-only: track Disposable leaks. Report on beforeunload.
  if (import.meta.env.DEV) {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    window.addEventListener('beforeunload', () => {
      const report = tracker.computeLeakingDisposables()
      if (report) {
        console.warn(
          `[renderer] ${report.leaks.length} Disposable leak(s) detected:\n${report.details}`,
        )
      }
    })
  }

  const services = new ServiceCollection()

  // Telemetry: noop sink by default; wire real sinks via ITelemetrySinkRegistry later.
  const telemetry = new NoopTelemetryService()
  services.set(ITelemetryService, telemetry)
  setErrorTelemetryHook((name, data) => telemetry.publicLogError(name, data))

  // Platform services
  const lifecycle = new LifecycleService()
  services.set(ILifecycleService, lifecycle)

  // ContextKey service is consumed by menus, keybindings, and Action2 preconditions.
  // No dependencies on other services — safe to set this early.
  const contextKeyService = new ContextKeyService()
  services.set(IContextKeyService, contextKeyService)

  // IPC must be available before any service that proxies main-side channels.
  const ipcService = createRendererIpcService()
  services.set(IIpcService, ipcService)

  // Logger: route renderer logs to the main process for file-based aggregation.
  // Use a stable per-session integer so renderer-<id>.log files are unique.
  const windowId = Date.now()
  const logChannelProxy = ProxyChannel.toService<ILogChannelService>(
    ipcService.getChannel(ServiceChannels.Log),
  )
  const loggerService = new RendererLoggerService(logChannelProxy, windowId)
  services.set(ILoggerService, loggerService)
  window.addEventListener('beforeunload', () => {
    void loggerService.flush()
  })
  // Update the global unexpected-error handler to also send to the file logger.
  const rootLogger = loggerService.createLogger({ id: 'renderer', name: 'Renderer' })
  rootLogger.info(`bootstrap start windowId=${windowId}`)
  setMonacoLoaderLogger(loggerService.createLogger({ id: 'monaco', name: 'Monaco' }))
  setUnexpectedErrorHandler((e) => {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
    rootLogger.error(msg)
  })

  // Cross-process services: bind interface directly to a ProxyChannel-derived
  // proxy. No renderer wrapper class — adding a new service is one line.
  const platform = normalizePlatform(window.ipc?.platform)
  services.set(
    IHostService,
    ProxyChannel.toService<IHostService>(ipcService.getChannel(ServiceChannels.Host), {
      properties: new Map<string, unknown>([['platform', platform]]),
    }),
  )
  services.set(
    IStorageService,
    ProxyChannel.toService<IStorageService>(ipcService.getChannel(ServiceChannels.Storage)),
  )
  services.set(
    IPingService,
    ProxyChannel.toService<IPingService>(ipcService.getChannel(ServiceChannels.Ping)),
  )
  services.set(
    IFileService,
    ProxyChannel.toService<IFileService>(ipcService.getChannel(ServiceChannels.FileSystem)),
  )
  services.set(
    IFileWatcherService,
    ProxyChannel.toService<IFileWatcherService>(ipcService.getChannel(ServiceChannels.FileWatcher)),
  )
  services.set(
    IUserDataFilesService,
    ProxyChannel.toService<IUserDataFilesService>(ipcService.getChannel(ServiceChannels.UserData)),
  )
  services.set(
    ILogFilesService,
    ProxyChannel.toService<ILogFilesService>(ipcService.getChannel(ServiceChannels.LogFiles)),
  )
  services.set(
    IAcpHostService,
    ProxyChannel.toService<IAcpHostService>(ipcService.getChannel(ServiceChannels.AcpHost)),
  )
  services.set(
    IAcpTerminalService,
    ProxyChannel.toService<IAcpTerminalService>(ipcService.getChannel(ServiceChannels.AcpTerminal)),
  )
  await initializeRendererNls(
    services.get(IUserDataFilesService) as IUserDataFilesService,
    window.navigator.language,
  )
  const workspaceWire = ProxyChannel.toService<IWorkspaceServiceWire>(
    ipcService.getChannel(ServiceChannels.Workspace),
  )
  const workspaceService = new RendererWorkspaceService(
    workspaceWire,
    telemetry,
    loggerService.createLogger({ id: 'workspace', name: 'Workspace' }),
  )
  services.set(IWorkspaceService, workspaceService)

  // Configuration core. UserSettingsSync (below) bridges the User layer to
  // IStorageService so user settings persist across restarts.
  const configurationService = new ConfigurationService()
  services.set(IConfigurationService, configurationService)

  // Create the DI container (registers itself as IInstantiationService)
  const instantiation = new InstantiationService(services)

  // Renderer-only service implementations (pure local state, no IPC).
  const editorGroupsService = new EditorGroupsService(
    loggerService.createLogger({ id: 'editorGroups', name: 'Editor Groups' }),
  )
  const editorService = new EditorService(
    editorGroupsService,
    telemetry,
    loggerService.createLogger({ id: 'editor', name: 'Editor' }),
  )
  const statusBarService = new StatusBarService()
  const outputService = instantiation.createInstance(OutputService)
  const commandService = new CommandService(
    instantiation,
    telemetry,
    loggerService.createLogger({ id: 'command', name: 'Command' }),
  )

  services.set(ICommandService, commandService)
  services.set(IEditorGroupsService, editorGroupsService)
  services.set(IEditorService, editorService)
  services.set(IStatusBarService, statusBarService)
  services.set(IOutputService, outputService)

  // EditorResolverService depends on IInstantiationService + IEditorService, both available now.
  const editorResolverService = instantiation.createInstance(EditorResolverService)
  services.set(IEditorResolverService, editorResolverService)

  // Services with @IStorageService dependencies go through DI.
  const viewsService = instantiation.createInstance(ViewsService)
  services.set(IViewsService, viewsService)
  const quickInputService = instantiation.createInstance(QuickInputService)
  services.set(IQuickInputService, quickInputService)
  const layoutService = instantiation.createInstance(LayoutService)
  services.set(ILayoutService, layoutService)

  const recentFilesService = instantiation.createInstance(RecentFilesService)
  services.set(IRecentFilesService, recentFilesService)

  const recentEditorsService = instantiation.createInstance(RecentEditorsService)
  services.set(IRecentEditorsService, recentEditorsService)

  // IDialogService — React-portal-backed; <DialogHost /> is mounted by Workbench.
  const dialogService = new RendererDialogService()
  services.set(IDialogService, dialogService)

  // INotificationService — per-window, renderer-only. <NotificationsToast /> and
  // <NotificationsCenter /> are mounted as portals by Workbench.
  const notificationService = instantiation.createInstance(NotificationService)
  services.set(INotificationService, notificationService)
  // IProgressService — depends on StatusBar + Notification (both already set).
  const progressService = instantiation.createInstance(ProgressService)
  services.set(IProgressService, progressService)
  // Route unhandled errors to the sticky Error toast so they're visible to users.
  setUnexpectedErrorHandler((e) => {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
    rootLogger.error(msg)
    notificationService.notify({
      severity: Severity.Error,
      message: e instanceof Error ? e.message : String(e),
      sticky: true,
    })
  })

  // Explorer tree state — single instance for the renderer; depends on
  // IWorkspaceService + IFileService so it must be created via DI.
  const explorerTreeService = instantiation.createInstance(ExplorerTreeService)
  services.set(IExplorerTreeService, explorerTreeService)

  // Workspace-wide text search. Reads via IFileService + IWorkspaceService.
  const textSearchService = instantiation.createInstance(TextSearchService)
  services.set(ITextSearchService, textSearchService)

  // ACP (Agent Client Protocol) services. AgentRegistry depends only on
  // IConfigurationService; ClientService brings together host + permission
  // + IFileService + IOutputService; SessionService owns Session state and
  // drives the connection.
  const acpAgentRegistry = instantiation.createInstance(AcpAgentRegistry)
  services.set(IAcpAgentRegistry, acpAgentRegistry)
  const acpPathPolicy = new AcpPathPolicy({
    platform,
    home: typeof window.ipc?.home === 'string' ? window.ipc.home : '',
  })
  services.set(IAcpPathPolicy, acpPathPolicy)
  const acpPermissionHandler = instantiation.createInstance(AcpPermissionHandler)
  services.set(IAcpPermissionHandler, acpPermissionHandler)
  const acpClientService = instantiation.createInstance(AcpClientService)
  services.set(IAcpClientService, acpClientService)
  // History must be available before SessionService so createSession can record
  // to it from the very first call. initialize() is fire-and-forget — early
  // adds are merged in once hydration completes.
  const acpSessionHistoryService = instantiation.createInstance(AcpSessionHistoryService)
  services.set(IAcpSessionHistoryService, acpSessionHistoryService)
  void acpSessionHistoryService.initialize()
  const acpSessionService = instantiation.createInstance(AcpSessionService)
  services.set(IAcpSessionService, acpSessionService)

  // Kick off async load of user settings from storage. Once it resolves,
  // ConfigurationService fires onDidChangeConfiguration so any subscribers
  // (Settings editor, theme contributions) refresh — no need to await here.
  const userSettingsSync = instantiation.createInstance(UserSettingsSync)
  void userSettingsSync.initialize()

  // User keybinding overrides. Must be created after all actions are registered
  // (they run at module-load time via side-effect imports) so the default
  // snapshot in the constructor captures all built-in keybindings.
  await import('./contributions/index.js')
  const userKeybindingsService = instantiation.createInstance(UserKeybindingsService)
  services.set(IUserKeybindingsService, userKeybindingsService)
  void userKeybindingsService.initialize()

  // Instantiate the six workbench Parts. Each Part auto-registers with the
  // LayoutService on construction; React lookups (`getPart`) resolve them.
  for (const Ctor of ALL_PART_CTORS) {
    instantiation.createInstance(Ctor)
  }

  // ContributionService wires lifecycle → built-in contributions auto-instantiate.
  // The side-effect import at the top of this file populated the registry.
  const contributionService = new ContributionService(lifecycle, instantiation)
  services.set(IContributionService, contributionService)

  // Create default output channel
  const mainChannel = outputService.createChannel(localize('app.name', 'Universe Editor'))
  mainChannel.appendLine('[Workbench] Starting up…')

  // Advance to Ready before mounting React (triggers BlockRestore contributions)
  lifecycle.setPhase(LifecyclePhase.Ready)

  // E2E probe: only attaches when the app was launched with UNIVERSE_E2E=1.
  installE2EProbeIfEnabled({
    commandService,
    contextKeyService,
    lifecycleService: lifecycle,
    editorService,
    editorGroupsService,
    editorResolverService,
    statusBarService,
    workspaceService,
    layoutService,
    configurationService,
    acpSessionService,
    outputService,
  })

  // Load persisted layout and view state before mounting React so Allotment starts with the
  // correct preferredSize. Allotment 1.20.5 only reads preferredSize on mount
  // (or pane-show); changing it after mount is silently ignored.
  await Promise.all([layoutService.load(), viewsService.load()])
  rootLogger.info('bootstrap services restored')

  // Mount
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('[bootstrap] #root element not found')

  const { Workbench } = await import('./workbench/Workbench.js')
  const { WorkbenchErrorBoundary } = await import('./workbench/errors/WorkbenchErrorBoundary.js')

  createRoot(rootEl).render(
    <StrictMode>
      <WorkbenchErrorBoundary logger={rootLogger}>
        <Workbench instantiation={instantiation} lifecycle={lifecycle} />
      </WorkbenchErrorBoundary>
    </StrictMode>,
  )
  rootLogger.info('bootstrap mounted')
}

void bootstrapWorkbench()
