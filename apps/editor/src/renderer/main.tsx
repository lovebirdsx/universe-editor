import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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
  IFocusableRegistry,
  IFocusStackService,
  IHistoryService,
  IStatusBarService,
  ITextSearchService,
  IViewsService,
  IQuickInputService,
  IOutputService,
  ILayoutService,
  PartId,
  IHostService,
  IWindowsService,
  IIpcService,
  IStorageService,
  IConfigurationService,
  IUserDataFilesService,
  IWorkspaceService,
  IFocusTrackerService,
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
  DisposableStore,
  DisposableTracker,
  localize,
  markAsSingleton,
  MutableDisposable,
  setDisposableTracker,
  setErrorTelemetryHook,
  setUnexpectedErrorHandler,
  normalizePlatform,
  installConsoleInterceptor,
} from '@universe-editor/platform'
import { ServiceChannels } from '../shared/ipc/channelNames.js'
import {
  IDisposableLeakService,
  ILogChannelService,
  ILogFilesService,
  IPingService,
} from '../shared/ipc/services.js'
import { IAcpHostService } from '../shared/ipc/acpHostService.js'
import { IAcpTerminalService } from '../shared/ipc/acpTerminalService.js'
import { IClaudeBinaryService } from '../shared/ipc/claudeBinaryService.js'
import { initializeRendererNls } from '../shared/i18n/bootstrap.js'
import { DISPOSABLE_LEAK_REPORT_KEY, E2E_PROBE_ENABLED_KEY } from '../shared/e2e/contract.js'
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
import { RendererFocusTrackerService } from './services/focus/RendererFocusTrackerService.js'
import { FocusableRegistry } from './services/focus/FocusableRegistry.js'
import {
  IViewContainerMemoryService,
  ViewContainerMemoryService,
} from './services/focus/ViewContainerMemoryService.js'
import { FocusStackService } from './services/focus/FocusStackService.js'
import { HistoryService } from './services/history/HistoryService.js'
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
import {
  AcpAgentDefaultsService,
  IAcpAgentDefaultsService,
} from './services/acp/acpAgentDefaultsService.js'
import { AcpSessionService, IAcpSessionService } from './services/acp/acpSessionService.js'
import { AcpChatWidgetService, IAcpChatWidgetService } from './services/acp/acpChatWidgetService.js'
import {
  AcpChatLocationService,
  IAcpChatLocationService,
} from './services/acp/acpChatLocationService.js'
import {
  IRendererDisposableLeakService,
  RendererDisposableLeakService,
} from './services/disposableLeak/DisposableLeakService.js'
import './workbench.css'
import { installE2EProbeIfEnabled } from './e2e/probe.js'

// Install global error handlers before any async work.
setUnexpectedErrorHandler((e) => console.error('[renderer] unexpected error:', e))
installRendererErrorHandlers()

async function bootstrapWorkbench(): Promise<void> {
  const isE2E = typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true

  // Hoisted so the dev/E2E leak-check beforeunload listener can unmount React
  // before snapshotting — without that, useEffect cleanups (e.g. event
  // subscriptions in FileEditor) haven't run yet and show up as false leaks.
  let reactRoot: Root | null = null

  // DEV or E2E: install the Disposable tracker. The beforeunload handler is
  // registered later (after the IPC + leak proxy are up) so it can persist the
  // report to main for the next session.
  const tracker = import.meta.env.DEV || isE2E ? new DisposableTracker() : null
  if (tracker) {
    setDisposableTracker(tracker)
  }

  // Singleton root store: all explicitly-created root services are added here so the
  // DisposableTracker does not report them as leaks on page unload (e.g. Restart Editor).
  const workbenchStore = markAsSingleton(new DisposableStore())

  const services = new ServiceCollection()

  // Telemetry: noop sink by default; wire real sinks via ITelemetrySinkRegistry later.
  const telemetry = new NoopTelemetryService()
  services.set(ITelemetryService, telemetry)
  setErrorTelemetryHook((name, data) => telemetry.publicLogError(name, data))

  // Platform services
  const lifecycle = workbenchStore.add(new LifecycleService())
  services.set(ILifecycleService, lifecycle)

  // ContextKey service is consumed by menus, keybindings, and Action2 preconditions.
  // No dependencies on other services — safe to set this early.
  const contextKeyService = workbenchStore.add(new ContextKeyService())
  services.set(IContextKeyService, contextKeyService)

  // FocusTracker observes document-level focusin/focusout with debounce. Used
  // by FocusContextKeyContribution + LayoutService.focusPart to settle DOM
  // transitions before re-reading focus.
  const focusTracker = workbenchStore.add(new RendererFocusTrackerService(window.document))
  services.set(IFocusTrackerService, focusTracker)

  // FocusableRegistry: viewId → focusable element getter. Views register via
  // useViewFocusable; LayoutService.focusView consults this to focus the right
  // input/tree after the host part mounts.
  const focusableRegistry = workbenchStore.add(new FocusableRegistry())
  services.set(IFocusableRegistry, focusableRegistry)

  // ViewContainerMemory: containerId → lastFocusedViewId. Pure storage with no
  // deps; FocusStackService writes to it on focus changes, LayoutService.focusPart
  // reads it to delegate to focusView when re-entering a part.
  const viewContainerMemory = workbenchStore.add(new ViewContainerMemoryService())
  services.set(IViewContainerMemoryService, viewContainerMemory)

  // IPC must be available before any service that proxies main-side channels.
  const ipcService = workbenchStore.add(createRendererIpcService())
  services.set(IIpcService, ipcService)

  // Disposable leak reporting (dev/E2E only): cross-process service that
  // persists this session's leaks for the next bootstrap to surface. Created
  // here because the beforeunload handler below references it.
  const disposableLeakProxy = ProxyChannel.toService<IDisposableLeakService>(
    ipcService.getChannel(ServiceChannels.DisposableLeak),
  )
  const rendererLeakService = new RendererDisposableLeakService(disposableLeakProxy)
  services.set(IRendererDisposableLeakService, rendererLeakService)

  if (tracker) {
    window.addEventListener('beforeunload', () => {
      reactRoot?.unmount()
      const report = tracker.computeLeakingDisposables()
      if (report) {
        if (import.meta.env.DEV) {
          console.warn(
            `[renderer] ${report.leaks.length} Disposable leak(s) detected:\n${report.details}`,
          )
        }
        if (isE2E) {
          sessionStorage.setItem(
            DISPOSABLE_LEAK_REPORT_KEY,
            JSON.stringify({ count: report.leaks.length, details: report.details }),
          )
        }
        // Fire-and-forget cross-process write. ProxyChannel dispatches the
        // request synchronously via ipcRenderer.send; the main process queues
        // it before the renderer is torn down, even though we cannot await
        // here. Skipped in production (tracker === null).
        void rendererLeakService.reportLeaks({
          count: report.leaks.length,
          details: report.details,
          capturedAt: Date.now(),
          source: rendererLeakService.readUnloadReason(),
        })
      } else if (isE2E) {
        sessionStorage.removeItem(DISPOSABLE_LEAK_REPORT_KEY)
      }
    })
  }

  // Logger: route renderer logs to the main process for file-based aggregation.
  // Use a stable per-session integer so renderer-<id>.log files are unique.
  const windowId = Date.now()
  const logChannelProxy = ProxyChannel.toService<ILogChannelService>(
    ipcService.getChannel(ServiceChannels.Log),
  )
  const loggerService = workbenchStore.add(new RendererLoggerService(logChannelProxy, windowId))
  services.set(ILoggerService, loggerService)
  window.addEventListener('beforeunload', () => {
    void loggerService.flush()
  })
  // Update the global unexpected-error handler to also send to the file logger.
  const rootLogger = loggerService.createLogger({ id: 'renderer', name: 'Renderer' })
  rootLogger.info(`bootstrap start windowId=${windowId}`)

  // Route console.* through the log system so ad-hoc console output and
  // third-party library noise reach the Console channel and Output panel
  // without requiring DevTools to be open.
  const consoleLogger = loggerService.createLogger({ id: 'console', name: 'Console' })
  workbenchStore.add(installConsoleInterceptor({ logger: consoleLogger }))

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
  services.set(
    IClaudeBinaryService,
    ProxyChannel.toService<IClaudeBinaryService>(
      ipcService.getChannel(ServiceChannels.ClaudeBinary),
    ),
  )
  const windowsService = ProxyChannel.toService<IWindowsService>(
    ipcService.getChannel(ServiceChannels.Window),
  )
  services.set(IWindowsService, windowsService)
  await initializeRendererNls(
    services.get(IUserDataFilesService) as IUserDataFilesService,
    window.navigator.language,
  )
  const workspaceWire = ProxyChannel.toService<IWorkspaceServiceWire>(
    ipcService.getChannel(ServiceChannels.Workspace),
  )
  const workspaceService = workbenchStore.add(
    new RendererWorkspaceService(
      workspaceWire,
      telemetry,
      loggerService.createLogger({ id: 'workspace', name: 'Workspace' }),
    ),
  )
  services.set(IWorkspaceService, workspaceService)

  // Configuration core. UserSettingsSync (below) bridges the User layer to
  // IStorageService so user settings persist across restarts.
  const configurationService = workbenchStore.add(new ConfigurationService())
  services.set(IConfigurationService, configurationService)

  // Create the DI container (registers itself as IInstantiationService)
  const instantiation = new InstantiationService(services)

  // Renderer-only service implementations (pure local state, no IPC).
  const editorGroupsService = workbenchStore.add(
    new EditorGroupsService(
      loggerService.createLogger({ id: 'editorGroups', name: 'Editor Groups' }),
    ),
  )
  const editorService = workbenchStore.add(
    new EditorService(
      editorGroupsService,
      telemetry,
      loggerService.createLogger({ id: 'editor', name: 'Editor' }),
    ),
  )
  const statusBarService = new StatusBarService()
  const outputService = workbenchStore.add(instantiation.createInstance(OutputService))
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

  outputService.createChannel('All', 'aggregated')

  // EditorResolverService depends on IInstantiationService + IEditorService, both available now.
  const editorResolverService = instantiation.createInstance(EditorResolverService)
  services.set(IEditorResolverService, editorResolverService)

  // Services with @IStorageService dependencies go through DI.
  const viewsService = workbenchStore.add(instantiation.createInstance(ViewsService))
  services.set(IViewsService, viewsService)
  const quickInputService = instantiation.createInstance(QuickInputService)
  services.set(IQuickInputService, quickInputService)
  const layoutService = workbenchStore.add(instantiation.createInstance(LayoutService))
  services.set(ILayoutService, layoutService)

  // FocusStack: bounded-size focus history backed by IFocusTrackerService.
  // Drives F6/Shift+F6 cross-Part navigation and Monaco blur arbitration; also
  // updates ViewContainerMemory whenever a view-scoped focus is recorded.
  const focusStackService = workbenchStore.add(instantiation.createInstance(FocusStackService))
  services.set(IFocusStackService, focusStackService)

  // HistoryService: bounded back/forward navigation across editors. Records
  // are pushed by HistoryContribution from Monaco cursor changes; GoBack /
  // GoForward actions pop entries and reopen + restore selection.
  const historyService = workbenchStore.add(new HistoryService())
  services.set(IHistoryService, historyService)

  const recentFilesService = workbenchStore.add(instantiation.createInstance(RecentFilesService))
  services.set(IRecentFilesService, recentFilesService)

  const recentEditorsService = workbenchStore.add(
    instantiation.createInstance(RecentEditorsService),
  )
  services.set(IRecentEditorsService, recentEditorsService)

  // IDialogService — React-portal-backed; <DialogHost /> is mounted by Workbench.
  const dialogService = workbenchStore.add(new RendererDialogService())
  services.set(IDialogService, dialogService)

  // INotificationService — per-window, renderer-only. <NotificationsToast /> and
  // <NotificationsCenter /> are mounted as portals by Workbench.
  const notificationService = workbenchStore.add(instantiation.createInstance(NotificationService))
  services.set(INotificationService, notificationService)
  // IProgressService — depends on StatusBar + Notification (both already set).
  const progressService = workbenchStore.add(instantiation.createInstance(ProgressService))
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
  const explorerTreeService = workbenchStore.add(instantiation.createInstance(ExplorerTreeService))
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
  const acpClientService = workbenchStore.add(instantiation.createInstance(AcpClientService))
  services.set(IAcpClientService, acpClientService)
  // History must be available before SessionService so createSession can record
  // to it from the very first call. initialize() is fire-and-forget — early
  // adds are merged in once hydration completes.
  const acpSessionHistoryService = workbenchStore.add(
    instantiation.createInstance(AcpSessionHistoryService),
  )
  services.set(IAcpSessionHistoryService, acpSessionHistoryService)
  void acpSessionHistoryService.initialize()
  // Per-agent MODEL/MODE defaults — separate storage key from history so users
  // clearing one don't blow away the other. Must be available before
  // SessionService so createSession can apply saved defaults on first use.
  const acpAgentDefaultsService = workbenchStore.add(
    instantiation.createInstance(AcpAgentDefaultsService),
  )
  services.set(IAcpAgentDefaultsService, acpAgentDefaultsService)
  void acpAgentDefaultsService.initialize()
  const acpSessionService = workbenchStore.add(instantiation.createInstance(AcpSessionService))
  services.set(IAcpSessionService, acpSessionService)

  // Renderer-only AGENTS UI state. ChatWidget tracks focused ChatBody for
  // single-target action dispatch. ChatLocation persists across restarts and
  // owns the EditorArea↔SecondarySideBar toggle.
  const acpChatWidgetService = workbenchStore.add(
    instantiation.createInstance(AcpChatWidgetService),
  )
  services.set(IAcpChatWidgetService, acpChatWidgetService)
  const acpChatLocationService = workbenchStore.add(
    instantiation.createInstance(AcpChatLocationService),
  )
  services.set(IAcpChatLocationService, acpChatLocationService)
  void acpChatLocationService.initialize()

  // Kick off async load of user settings from storage. Once it resolves,
  // ConfigurationService fires onDidChangeConfiguration so any subscribers
  // (Settings editor, theme contributions) refresh — no need to await here.
  const userSettingsSync = workbenchStore.add(instantiation.createInstance(UserSettingsSync))
  void userSettingsSync.initialize()

  // User keybinding overrides. Must be created after all actions are registered
  // (they run at module-load time via side-effect imports) so the default
  // snapshot in the constructor captures all built-in keybindings.
  await import('./contributions/index.js')
  const userKeybindingsService = workbenchStore.add(
    instantiation.createInstance(UserKeybindingsService),
  )
  services.set(IUserKeybindingsService, userKeybindingsService)
  void userKeybindingsService.initialize()

  // Instantiate the six workbench Parts. Each Part auto-registers with the
  // LayoutService on construction; React lookups (`getPart`) resolve them.
  for (const Ctor of ALL_PART_CTORS) {
    workbenchStore.add(instantiation.createInstance(Ctor))
  }

  // Bridge FocusTracker → per-Part onDidFocus/onDidBlur. We use trackElement on
  // each Part's container as it mounts; unmount clears the tracker disposable.
  // MutableDisposable + workbenchStore: parent chain reaches a singleton root, so
  // the leak detector won't report the tracker subscription when beforeunload
  // fires before React unmounts.
  for (const part of layoutService.getParts()) {
    const trackerSub = workbenchStore.add(new MutableDisposable())
    const attach = () => {
      const container = part.getContainer() as unknown as HTMLElement | undefined
      if (!container) {
        trackerSub.clear()
        return
      }
      trackerSub.value = focusTracker.trackElement(container, (focused) => {
        ;(part as unknown as { _notifyFocusChange(f: boolean): void })._notifyFocusChange(focused)
      })
    }
    workbenchStore.add(part.onDidMount(attach))
    workbenchStore.add(part.onDidUnmount(() => trackerSub.clear()))
    if (part.mountState === 'mounted') attach()
  }

  // ContributionService wires lifecycle → built-in contributions auto-instantiate.
  // The side-effect import at the top of this file populated the registry.
  const contributionService = workbenchStore.add(new ContributionService(lifecycle, instantiation))
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
    windowsService,
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

  // Surface any Disposable leak report left by the previous session. We always
  // consume (which deletes the file) so a stale report doesn't outlive its
  // usefulness; production renderer has tracker === null and never writes,
  // so we skip the consume call entirely there.
  if (tracker) {
    void rendererLeakService
      .consumePendingReport()
      .then((report) => {
        if (!report) return
        const channel =
          outputService.getChannel('Disposable Leaks') ??
          outputService.createChannel('Disposable Leaks')
        channel.appendLine(
          `[${new Date(report.capturedAt).toISOString()}] source=${report.source} count=${report.count}`,
        )
        channel.appendLine(report.details)
        channel.appendLine('')
        // 'restart' means the user already saw the modal in the previous session
        // (RestartEditorAction). Skip the notification to avoid duplicate noise;
        // the Output channel still has the details for reference.
        if (report.source === 'restart') return
        notificationService.notify({
          severity: Severity.Warning,
          message: localize(
            'restart.leakDetected.message',
            'Detected {count} un-disposed Disposable(s)',
            { count: report.count },
          ),
          sticky: true,
          actions: [
            {
              label: localize('common.details', 'Details'),
              run: () => {
                viewsService.openViewContainer('workbench.view.output')
                layoutService.setVisible(PartId.Panel, true)
                layoutService.getPart(PartId.Panel)?.focus()
                outputService.setActiveChannel('Disposable Leaks')
              },
            },
          ],
        })
      })
      .catch((err: unknown) => {
        rootLogger.warn(`disposableLeak consume failed: ${(err as Error).message}`)
      })
  }

  // Mount
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('[bootstrap] #root element not found')

  const { Workbench } = await import('./workbench/Workbench.js')
  const { WorkbenchErrorBoundary } = await import('./workbench/errors/WorkbenchErrorBoundary.js')

  reactRoot = createRoot(rootEl)
  reactRoot.render(
    <StrictMode>
      <WorkbenchErrorBoundary logger={rootLogger}>
        <Workbench instantiation={instantiation} lifecycle={lifecycle} />
      </WorkbenchErrorBoundary>
    </StrictMode>,
  )
  rootLogger.info('bootstrap mounted')
}

void bootstrapWorkbench()
