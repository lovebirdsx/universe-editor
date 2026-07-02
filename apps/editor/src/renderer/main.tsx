import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ServiceCollection,
  InstantiationService,
  getSingletonServiceDescriptors,
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
  IFocusableRegistry,
  IFocusStackService,
  IHistoryService,
  IStatusBarService,
  IViewsService,
  IViewDescriptorService,
  IOutputService,
  ILayoutService,
  PartId,
  IWindowsService,
  IIpcService,
  IConfigurationService,
  IAiModelService,
  IUserDataFilesService,
  IWorkspaceService,
  IFocusTrackerService,
  IUriIdentityService,
  UriIdentityService,
  type IWorkspaceServiceWire,
  ConfigurationService,
  ContributionService,
  IContributionService,
  ILoggerService,
  INotificationService,
  ITelemetryService,
  NoopTelemetryService,
  Severity,
  ProxyChannel,
  DisposableStore,
  DisposableTracker,
  localize,
  mark,
  markAsSingleton,
  setDisposableTracker,
  setErrorTelemetryHook,
  setUnexpectedErrorHandler,
  normalizePlatform,
  installConsoleInterceptor,
} from '@universe-editor/platform'
import { ServiceChannels } from '../shared/ipc/channelNames.js'
import { PerfMarks } from '../shared/perf/marks.js'
import { IDisposableLeakService, ILogChannelService } from '../shared/ipc/services.js'
import { IUpdateService } from '../shared/ipc/updateService.js'
import { ITerminalService } from '../shared/ipc/terminalService.js'
import { type IAiModelMainService } from '../shared/ipc/aiModelService.js'
import { IAiDebugService } from '../shared/ipc/aiDebugService.js'
import { ITimerService } from './services/performance/TimerService.js'
import { IRemoteSchemaService } from '../shared/ipc/remoteSchemaService.js'
import { IClaudeConfigService } from '../shared/ipc/claudeConfigService.js'
import { AiModelClientService } from './services/ai/aiModelClientService.js'
import { initializeRendererNls } from '../shared/i18n/bootstrap.js'
import { DISPOSABLE_LEAK_REPORT_KEY, E2E_PROBE_ENABLED_KEY } from '../shared/e2e/contract.js'
import { createRendererIpcService } from './ipc/bootstrap.js'
import { registerProxyChannelServices } from './ipc/registerProxyServices.js'
import { installRendererErrorHandlers } from './errors.js'
import { RendererLoggerService } from './services/log/rendererLoggerService.js'
import { CommandService } from './services/command/CommandService.js'
import { EditorService } from './services/editor/EditorService.js'
import { EditorGroupsService } from './services/editor/EditorGroupsService.js'
import { StatusBarService } from './services/statusbar/StatusBarService.js'
import { ViewsService } from './services/views/ViewsService.js'
import { ViewDescriptorService } from './services/views/ViewDescriptorService.js'
import { OutputService } from './services/output/OutputService.js'
import {
  IKeyboardDebugService,
  KeyboardDebugService,
} from './services/keybinding/keyboardDebugService.js'
import { LayoutService } from './services/layout/LayoutService.js'
import { RendererDialogService } from './services/dialog/RendererDialogService.js'
import { NotificationService } from './services/notification/NotificationService.js'
import { RendererFocusTrackerService } from './services/focus/RendererFocusTrackerService.js'
import { FocusableRegistry } from './services/focus/FocusableRegistry.js'
import {
  IViewContainerMemoryService,
  ViewContainerMemoryService,
} from './services/focus/ViewContainerMemoryService.js'
import { FocusStackService } from './services/focus/FocusStackService.js'
import { HistoryService } from './services/history/HistoryService.js'
import { RendererWorkspaceService } from './services/workspace/RendererWorkspaceService.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from './services/explorer/ExplorerTreeService.js'
import { setMonacoLoaderLogger } from './workbench/editor/monaco/MonacoLoader.js'
import {
  IRecentFilesService,
  RecentFilesService,
} from './services/recentFiles/recentFilesService.js'
import {
  IRecentEditorsService,
  RecentEditorsService,
} from './services/editor/RecentEditorsService.js'
import {
  IClosedEditorsService,
  ClosedEditorsService,
} from './services/editor/ClosedEditorsService.js'
import { EditorResolverService } from './services/editor/EditorResolverService.js'
import {
  ILanguageFeaturesService,
  LanguageFeaturesService,
} from './services/languageFeatures/LanguageFeaturesService.js'
import {
  IInlineCompletionService,
  InlineCompletionService,
} from './services/ai/InlineCompletionService.js'
import { IRecentEditsTracker, RecentEditsTracker } from './services/ai/RecentEditsTracker.js'
import { IOutlineService, OutlineService } from './services/languageFeatures/OutlineService.js'
import { AcpPathPolicy, IAcpPathPolicy } from './services/acp/acpPathPolicy.js'
import { AcpClientService, IAcpClientService } from './services/acp/acpClientService.js'
import { AcpSessionService, IAcpSessionService } from './services/acp/acpSessionService.js'
import {
  AcpPromptHistoryService,
  IAcpPromptHistoryService,
} from './services/acp/acpPromptHistoryService.js'
// Side-effect import: registers IAcpSessionFilterService before the
// getSingletonServiceDescriptors() snapshot below picks it up.
import './services/acp/acpSessionFilterService.js'
// Side-effect import: registers IQuickAccessController for the same snapshot.
import './services/quickInput/QuickAccessController.js'
import { AcpChatWidgetService, IAcpChatWidgetService } from './services/acp/acpChatWidgetService.js'
import {
  ExtensionHostClientService,
  IExtensionHostClientService,
} from './services/extensions/ExtensionHostClientService.js'
import { IScmService, ScmService } from './services/extensions/ScmService.js'
import {
  IScmDecorationsService,
  ScmDecorationsService,
} from './services/scm/ScmDecorationsService.js'
import {
  IDirtyDiffNavigationService,
  DirtyDiffNavigationService,
} from './services/scm/DirtyDiffNavigationService.js'
import { IActivityService, ActivityService } from './services/activity/ActivityService.js'
import {
  IRendererDisposableLeakService,
  RendererDisposableLeakService,
} from './services/disposableLeak/DisposableLeakService.js'
import { RendererLifecycleService } from './services/lifecycle/RendererLifecycleService.js'
import { RendererSessionsService } from './services/sessionSwitcher/RendererSessionsService.js'
import { ITerminalManagerService } from './services/terminal/TerminalManagerService.js'
import { ApiUsageService, IApiUsageService } from './services/usage/ApiUsageService.js'
import '@universe-editor/workbench-ui/tokens.css'
import '@vscode/codicons/dist/codicon.css'
import './workbench.css'
import './services/index.js'
import { installE2EProbeIfEnabled } from './e2e/probe.js'

// Install global error handlers before any async work.
setUnexpectedErrorHandler((e) => console.error('[renderer] unexpected error:', e))
installRendererErrorHandlers()

async function bootstrapWorkbench(): Promise<void> {
  mark(PerfMarks.rendererWillStartBootstrap)
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
  mark(PerfMarks.rendererDidCreateIpc)

  // Reverse channel: the main process invokes this before closing a window /
  // quitting so the renderer can run its lifecycle veto chain (e.g. confirm
  // before interrupting running sessions). The IpcService is full-duplex, so
  // registerChannel works without any extra wiring.
  ipcService.registerChannel(
    ServiceChannels.Lifecycle,
    ProxyChannel.fromService(new RendererLifecycleService(lifecycle)),
  )

  // Disposable leak reporting (dev/E2E only): cross-process service that
  // persists this session's leaks for the next bootstrap to surface. Created
  // here because the beforeunload handler below references it.
  const disposableLeakProxy = ProxyChannel.toService<IDisposableLeakService>(
    ipcService.getChannel(ServiceChannels.DisposableLeak),
  )
  const rendererLeakService = new RendererDisposableLeakService(disposableLeakProxy)
  services.set(IRendererDisposableLeakService, rendererLeakService)

  // Unmount React (so useEffect cleanups run and their subscriptions don't
  // show up as false leaks) then snapshot the tracker. Shared by the
  // beforeunload handler and the E2E teardown probe. Idempotent: clears
  // reactRoot so a second call is a no-op unmount. Returns null when the
  // tracker is absent or nothing leaked.
  const snapshotLeaks = (): { count: number; details: string } | null => {
    reactRoot?.unmount()
    reactRoot = null
    if (!tracker) return null
    const report = tracker.computeLeakingDisposables()
    return report ? { count: report.leaks.length, details: report.details } : null
  }

  if (tracker) {
    window.addEventListener('beforeunload', () => {
      const snap = snapshotLeaks()
      if (snap) {
        if (import.meta.env.DEV) {
          console.warn(`[renderer] ${snap.count} Disposable leak(s) detected:\n${snap.details}`)
        }
        if (isE2E) {
          sessionStorage.setItem(DISPOSABLE_LEAK_REPORT_KEY, JSON.stringify(snap))
        }
        // Fire-and-forget cross-process write. ProxyChannel dispatches the
        // request synchronously via ipcRenderer.send; the main process queues
        // it before the renderer is torn down, even though we cannot await
        // here. Skipped in production (tracker === null).
        void rendererLeakService.reportLeaks({
          count: snap.count,
          details: snap.details,
          capturedAt: Date.now(),
          source: rendererLeakService.readUnloadReason(),
        })
      } else if (isE2E) {
        sessionStorage.removeItem(DISPOSABLE_LEAK_REPORT_KEY)
      }
    })
  }

  // Logger: route renderer logs to the main process for file-based aggregation.
  // The source window is the authoritative BrowserWindow id held by the main
  // receiver; the renderer no longer needs to supply one.
  const logChannelProxy = ProxyChannel.toService<ILogChannelService>(
    ipcService.getChannel(ServiceChannels.Log),
  )
  const loggerService = workbenchStore.add(new RendererLoggerService(logChannelProxy))
  services.set(ILoggerService, loggerService)
  window.addEventListener('beforeunload', () => {
    void loggerService.flush()
  })
  // Update the global unexpected-error handler to also send to the file logger.
  const rootLogger = loggerService.createLogger({ id: 'renderer', name: 'Renderer' })
  rootLogger.info('bootstrap start')

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

  // Cross-process services: each is a ProxyChannel-derived proxy bound to a
  // main-side channel. The full table lives in registerProxyServices.ts.
  const platform = normalizePlatform(window.ipc?.platform)
  registerProxyChannelServices(services, ipcService, platform)

  // Single source of truth for resource / path comparison. Binds the host
  // platform once so consumers never thread `platform` through or hand-roll
  // case-folding. No dependencies — set early; many services inject it.
  services.set(IUriIdentityService, new UriIdentityService(platform))
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

  // AI model facade: wraps the main-process transport proxy and reassembles
  // streams. Provider groups, per-model config and the active model selections
  // all live in aiSettings.json (read/written by main); this facade just proxies.
  // Consumers depend only on IAiModelService.
  const aiModelMainProxy = ProxyChannel.toService<IAiModelMainService>(
    ipcService.getChannel(ServiceChannels.AiModel),
  )
  const aiModelService = workbenchStore.add(new AiModelClientService(aiModelMainProxy))
  services.set(IAiModelService, aiModelService)

  // AI debug recorder/replay service (main-side). Backs the AI Debug side panel.
  services.set(
    IAiDebugService,
    ProxyChannel.toService<IAiDebugService>(ipcService.getChannel(ServiceChannels.AiDebug)),
  )

  // Shared Claude config (`~/.claude/settings.json`) read/write — the Agents
  // settings panel binds its controls to this; the built-in agent + local CLI
  // read the same file, so edits are shared.
  services.set(
    IClaudeConfigService,
    ProxyChannel.toService<IClaudeConfigService>(
      ipcService.getChannel(ServiceChannels.ClaudeConfig),
    ),
  )

  // Remote JSON schema downloader (main-side fetch + cache). Used by the JSON
  // schema association sources to resolve http(s) schema urls; trust/enable
  // policy is applied renderer-side before calling it.
  services.set(
    IRemoteSchemaService,
    ProxyChannel.toService<IRemoteSchemaService>(
      ipcService.getChannel(ServiceChannels.RemoteSchema),
    ),
  )

  // Feed all declaratively-registered singletons into the collection. The
  // `has` guard lets explicitly-set instances win, so this coexists with the
  // remaining manual wiring during the incremental migration to registerSingleton.
  for (const [id, descriptor] of getSingletonServiceDescriptors()) {
    if (!services.has(id)) services.set(id, descriptor)
  }

  // Create the DI container (registers itself as IInstantiationService). Added to
  // workbenchStore so the container — and every service it materializes — is
  // disposed on unload (the kernel marks materialized services as singletons).
  const instantiation = workbenchStore.add(new InstantiationService(services))

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

  // Keyboard-shortcut troubleshooting sink (depends on IOutputService).
  services.set(
    IKeyboardDebugService,
    workbenchStore.add(instantiation.createInstance(KeyboardDebugService)),
  )

  // EditorResolverService depends on IInstantiationService + IEditorService, both available now.
  const editorResolverService = instantiation.createInstance(EditorResolverService)
  services.set(IEditorResolverService, editorResolverService)

  // Language features facade: mirrors providers (for the Outline view) while
  // forwarding to Monaco (so built-in F12 / Shift+F12 peek works). No deps.
  const languageFeaturesService = workbenchStore.add(new LanguageFeaturesService())
  services.set(ILanguageFeaturesService, languageFeaturesService)

  // OutlineService: derives the active editor's symbol tree + cursor symbol from
  // the facade. Needs IEditorService + ILanguageFeaturesService, both set above.
  const outlineService = workbenchStore.add(instantiation.createInstance(OutlineService))
  services.set(IOutlineService, outlineService)

  // Services with @IStorageService dependencies go through DI.
  const viewDescriptorService = workbenchStore.add(
    instantiation.createInstance(ViewDescriptorService),
  )
  services.set(IViewDescriptorService, viewDescriptorService)
  const viewsService = workbenchStore.add(instantiation.createInstance(ViewsService))
  services.set(IViewsService, viewsService)
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
  const historyService = workbenchStore.add(instantiation.createInstance(HistoryService))
  services.set(IHistoryService, historyService)

  const recentFilesService = workbenchStore.add(instantiation.createInstance(RecentFilesService))
  services.set(IRecentFilesService, recentFilesService)

  const recentEditorsService = workbenchStore.add(
    instantiation.createInstance(RecentEditorsService),
  )
  services.set(IRecentEditorsService, recentEditorsService)

  const closedEditorsService = workbenchStore.add(
    instantiation.createInstance(ClosedEditorsService),
  )
  services.set(IClosedEditorsService, closedEditorsService)

  // IDialogService — React-portal-backed; <DialogHost /> is mounted by Workbench.
  const dialogService = workbenchStore.add(new RendererDialogService())
  services.set(IDialogService, dialogService)

  // INotificationService — per-window, renderer-only. <NotificationsToast /> and
  // <NotificationsCenter /> are mounted as portals by Workbench.
  const notificationService = workbenchStore.add(instantiation.createInstance(NotificationService))
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

  // Tracks the user's recent edits per file; the raw material for Next Edit
  // Suggestions. Must exist before InlineCompletionService, which injects it.
  const recentEditsTracker = workbenchStore.add(instantiation.createInstance(RecentEditsTracker))
  services.set(IRecentEditsTracker, recentEditsTracker)

  // Inline (ghost-text) AI completions. Depends on IAiModelService + config/
  // logger from the container, plus INotificationService (registered above).
  const inlineCompletionService = workbenchStore.add(
    instantiation.createInstance(InlineCompletionService),
  )
  services.set(IInlineCompletionService, inlineCompletionService)

  // Explorer tree state — single instance for the renderer; depends on
  // IWorkspaceService + IFileService so it must be created via DI.
  const explorerTreeService = workbenchStore.add(instantiation.createInstance(ExplorerTreeService))
  services.set(IExplorerTreeService, explorerTreeService)

  // ACP (Agent Client Protocol) services. PathPolicy needs static platform/home
  // args; ClientService brings together host + permission + IFileService +
  // IOutputService; SessionService owns Session state and drives the connection.
  const acpPathPolicy = new AcpPathPolicy({
    platform,
    home: typeof window.ipc?.home === 'string' ? window.ipc.home : '',
  })
  services.set(IAcpPathPolicy, acpPathPolicy)
  const acpClientService = workbenchStore.add(instantiation.createInstance(AcpClientService))
  services.set(IAcpClientService, acpClientService)
  // History + agent-defaults are registerSingleton services injected by
  // AcpSessionService (materialized here); AcpInitContribution drives their
  // initialize() on the lifecycle timeline.
  const acpSessionService = workbenchStore.add(instantiation.createInstance(AcpSessionService))
  services.set(IAcpSessionService, acpSessionService)

  // Global prompt input history: persisted across workspaces/worktrees in GLOBAL scope.
  const acpPromptHistoryService = workbenchStore.add(
    instantiation.createInstance(AcpPromptHistoryService),
  )
  services.set(IAcpPromptHistoryService, acpPromptHistoryService)

  // Renderer-only AGENTS UI state. ChatWidget tracks focused ChatBody for
  // single-target action dispatch and session-specific focusing.
  const acpChatWidgetService = workbenchStore.add(
    instantiation.createInstance(AcpChatWidgetService),
  )
  services.set(IAcpChatWidgetService, acpChatWidgetService)

  // Reverse channel: main's cross-window session switcher lists/reveals this
  // window's live sessions. Registered after IAcpSessionService is set; the
  // service's other deps (chat location, history) are DI singletons.
  ipcService.registerChannel(
    ServiceChannels.RendererSessions,
    ProxyChannel.fromService(instantiation.createInstance(RendererSessionsService)),
  )

  // Extension host client: owns the extension-host subprocess + RPC. Created here
  // (after IOutputService/ILoggerService/proxy services are set) so the
  // ExtensionsContribution can inject it; it starts the host on an idle phase.
  const scmService = workbenchStore.add(new ScmService())
  services.set(IScmService, scmService)

  // Git status decorations derived from the SCM model; colours Explorer rows and
  // editor tabs by file change state.
  const scmDecorationsService = workbenchStore.add(new ScmDecorationsService(scmService))
  services.set(IScmDecorationsService, scmDecorationsService)

  // Holds the active editor's dirty-diff regions and the `quickDiffDecorationCount`
  // context key; consumed by the "go to next/previous change" commands. Eager so the
  // context key is seeded before any when-clause evaluates.
  services.set(
    IDirtyDiffNavigationService,
    instantiation.createInstance(DirtyDiffNavigationService),
  )

  // Activity Bar badges (unsaved files on Explorer, changed files on SCM).
  // Pure renderer state, no deps; contributions push counts into it.
  const activityService = workbenchStore.add(new ActivityService())
  services.set(IActivityService, activityService)

  const extensionHostClientService = workbenchStore.add(
    instantiation.createInstance(ExtensionHostClientService),
  )
  services.set(IExtensionHostClientService, extensionHostClientService)

  // API usage indicator: single owner of the account-level usage snapshot +
  // polling loop. Created here so its proxy + config deps are available; the
  // UsageIndicator in PromptInput subscribes to its observable.
  const apiUsageService = workbenchStore.add(instantiation.createInstance(ApiUsageService))
  services.set(IApiUsageService, apiUsageService)

  // Register all built-in contributions + actions (side-effect import) so the
  // ContributionService below can instantiate them by phase. UserSettingsSync +
  // UserKeybindings loads are driven by ConfigInitContribution (BlockStartup).
  await import('./contributions/index.js')

  // ContributionService wires lifecycle → built-in contributions auto-instantiate.
  // The side-effect import at the top of this file populated the registry.
  const contributionService = workbenchStore.add(instantiation.createInstance(ContributionService))
  services.set(IContributionService, contributionService)

  // Create default output channel
  const mainChannel = outputService.createChannel(localize('app.name', 'Universe Editor'))
  mainChannel.appendLine('[Workbench] Starting up…')

  // Advance to Ready before mounting React (triggers BlockRestore contributions)
  mark(PerfMarks.rendererWillRestore)
  lifecycle.setPhase(LifecyclePhase.Ready)

  // E2E probe: only attaches when the app was launched with UNIVERSE_E2E=1.
  const d = installE2EProbeIfEnabled({
    commandService,
    contextKeyService,
    lifecycleService: lifecycle,
    editorService,
    editorGroupsService,
    editorResolverService,
    statusBarService,
    workspaceService,
    windowsService: services.get(IWindowsService) as IWindowsService,
    layoutService,
    viewsService,
    viewDescriptorService,
    configurationService,
    acpSessionService,
    outputService,
    updateService: services.get(IUpdateService) as IUpdateService,
    terminalService: services.get(ITerminalService) as ITerminalService,
    scmService,
    languageFeaturesService: services.get(ILanguageFeaturesService) as ILanguageFeaturesService,
    outlineService,
    aiDebugService: services.get(IAiDebugService) as IAiDebugService,
    timerService: instantiation.invokeFunction((a) => a.get(ITimerService)),
    computeTeardownLeakReport: snapshotLeaks,
  })
  workbenchStore.add(d)

  // Load persisted layout and view state before mounting React so Allotment starts with the
  // correct preferredSize. Allotment 1.20.5 only reads preferredSize on mount
  // (or pane-show); changing it after mount is silently ignored.
  // Also restore panel terminals for the current workspace.
  const terminalManagerService = instantiation.invokeFunction((a) => a.get(ITerminalManagerService))
  await Promise.all([
    layoutService.load(),
    viewDescriptorService.load(),
    viewsService.load(),
    terminalManagerService.load(),
  ])
  rootLogger.info('bootstrap services restored')
  mark(PerfMarks.rendererDidRestoreServices)

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
        notificationService.notify({
          severity: Severity.Warning,
          message: localize(
            'reload.leakDetected.message',
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

  mark(PerfMarks.rendererWillMountReact)
  reactRoot = createRoot(rootEl)
  reactRoot.render(
    <StrictMode>
      <WorkbenchErrorBoundary logger={rootLogger}>
        <Workbench instantiation={instantiation} lifecycle={lifecycle} />
      </WorkbenchErrorBoundary>
    </StrictMode>,
  )
  rootLogger.info('bootstrap mounted')
  mark(PerfMarks.rendererDidMount)
}

void bootstrapWorkbench()
