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
  Severity,
  ProxyChannel,
  DisposableTracker,
  localize,
  setDisposableTracker,
  setUnexpectedErrorHandler,
  normalizePlatform,
} from '@universe-editor/platform'
import { ServiceChannels } from '../shared/ipc/channelNames.js'
import { IPingService, ILogChannelService } from '../shared/ipc/services.js'
import { initializeRendererNls } from '../shared/i18n/bootstrap.js'
import { createRendererIpcService } from './ipc/bootstrap.js'
import { installRendererErrorHandlers } from './errors.js'
import { RendererLoggerService } from './services/log/rendererLoggerService.js'
import { CommandService } from './workbench/CommandService.js'
import { EditorService } from './workbench/editor/EditorService.js'
import { EditorGroupsService } from './workbench/editor/EditorGroupsService.js'
import { StatusBarService } from './workbench/statusbar/StatusBarService.js'
import { ViewsService } from './workbench/sidebar/ViewsService.js'
import { QuickInputService } from './workbench/quickinput/QuickInputService.js'
import { OutputService } from './workbench/panel/output/OutputService.js'
import { LayoutService } from './workbench/layout/LayoutService.js'
import { RendererDialogService } from './workbench/dialog/RendererDialogService.js'
import { NotificationService } from './workbench/notification/NotificationService.js'
import { UserSettingsSync } from './workbench/configuration/UserSettingsSync.js'
import {
  UserKeybindingsService,
  IUserKeybindingsService,
} from './workbench/keybindings/UserKeybindingsService.js'
import { RendererWorkspaceService } from './workbench/workspace/RendererWorkspaceService.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from './workbench/explorer/ExplorerTreeService.js'
import { TextSearchService } from './workbench/search/TextSearchService.js'
import { ALL_PART_CTORS } from './workbench/parts/index.js'
import {
  IRecentFilesService,
  RecentFilesService,
} from './services/recentFiles/recentFilesService.js'
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
  // Update the global unexpected-error handler to also send to the file logger.
  const rootLogger = loggerService.createLogger({ id: 'renderer', name: 'Renderer' })
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
  await initializeRendererNls(
    services.get(IUserDataFilesService) as IUserDataFilesService,
    window.navigator.language,
  )
  const workspaceWire = ProxyChannel.toService<IWorkspaceServiceWire>(
    ipcService.getChannel(ServiceChannels.Workspace),
  )
  const workspaceService = new RendererWorkspaceService(workspaceWire)
  services.set(IWorkspaceService, workspaceService)

  // Configuration core. UserSettingsSync (below) bridges the User layer to
  // IStorageService so user settings persist across restarts.
  const configurationService = new ConfigurationService()
  services.set(IConfigurationService, configurationService)

  // Create the DI container (registers itself as IInstantiationService)
  const instantiation = new InstantiationService(services)

  // Renderer-only service implementations (pure local state, no IPC).
  const editorGroupsService = new EditorGroupsService()
  const editorService = new EditorService(editorGroupsService)
  const statusBarService = new StatusBarService()
  const outputService = new OutputService()
  const commandService = new CommandService(instantiation)

  services.set(ICommandService, commandService)
  services.set(IEditorGroupsService, editorGroupsService)
  services.set(IEditorService, editorService)
  services.set(IStatusBarService, statusBarService)
  services.set(IOutputService, outputService)

  // Services with @IStorageService dependencies go through DI.
  const viewsService = instantiation.createInstance(ViewsService)
  services.set(IViewsService, viewsService)
  const quickInputService = instantiation.createInstance(QuickInputService)
  services.set(IQuickInputService, quickInputService)
  const layoutService = instantiation.createInstance(LayoutService)
  services.set(ILayoutService, layoutService)

  const recentFilesService = instantiation.createInstance(RecentFilesService)
  services.set(IRecentFilesService, recentFilesService)

  // IDialogService — React-portal-backed; <DialogHost /> is mounted by Workbench.
  const dialogService = new RendererDialogService()
  services.set(IDialogService, dialogService)

  // INotificationService — per-window, renderer-only. <NotificationsToast /> and
  // <NotificationsCenter /> are mounted as portals by Workbench.
  const notificationService = instantiation.createInstance(NotificationService)
  services.set(INotificationService, notificationService)
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
    statusBarService,
    workspaceService,
    layoutService,
  })

  // Load persisted layout and view state before mounting React so Allotment starts with the
  // correct preferredSize. Allotment 1.20.5 only reads preferredSize on mount
  // (or pane-show); changing it after mount is silently ignored.
  await Promise.all([layoutService.load(), viewsService.load()])

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
}

void bootstrapWorkbench()
