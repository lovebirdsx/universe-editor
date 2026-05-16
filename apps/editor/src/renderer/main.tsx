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
  IWorkspaceService,
  type IWorkspaceServiceWire,
  ConfigurationService,
  ContributionService,
  IContributionService,
  ProxyChannel,
  DisposableTracker,
  setDisposableTracker,
  normalizePlatform,
} from '@universe-editor/platform'
import { ServiceChannels } from '../shared/ipc/channelNames.js'
import { IPingService } from '../shared/ipc/services.js'
import { createRendererIpcService } from './ipc/bootstrap.js'
import { Workbench } from './workbench/Workbench.js'
import { CommandService } from './workbench/CommandService.js'
import { EditorService } from './workbench/editor/EditorService.js'
import { EditorGroupsService } from './workbench/editor/EditorGroupsService.js'
import { StatusBarService } from './workbench/statusbar/StatusBarService.js'
import { ViewsService } from './workbench/sidebar/ViewsService.js'
import { QuickInputService } from './workbench/quickinput/QuickInputService.js'
import { OutputService } from './workbench/panel/output/OutputService.js'
import { LayoutService } from './workbench/layout/LayoutService.js'
import { RendererDialogService } from './workbench/dialog/RendererDialogService.js'
import { UserSettingsSync } from './workbench/configuration/UserSettingsSync.js'
import { RendererWorkspaceService } from './workbench/workspace/RendererWorkspaceService.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from './workbench/explorer/ExplorerTreeService.js'
import { TextSearchService } from './workbench/search/TextSearchService.js'
import { ALL_PART_CTORS } from './workbench/parts/index.js'
// Side-effect import: registers built-in contributions with ContributionsRegistry.
import './contributions/index.js'
import './workbench.css'

function bootstrapWorkbench(): void {
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
  const viewsService = new ViewsService()
  const outputService = new OutputService()
  const commandService = new CommandService(instantiation)

  services.set(ICommandService, commandService)
  services.set(IEditorGroupsService, editorGroupsService)
  services.set(IEditorService, editorService)
  services.set(IStatusBarService, statusBarService)
  services.set(IViewsService, viewsService)
  services.set(IOutputService, outputService)

  // Services with @IStorageService dependencies go through DI.
  const quickInputService = instantiation.createInstance(QuickInputService)
  services.set(IQuickInputService, quickInputService)
  const layoutService = instantiation.createInstance(LayoutService)
  services.set(ILayoutService, layoutService)

  // IDialogService — React-portal-backed; <DialogHost /> is mounted by Workbench.
  const dialogService = new RendererDialogService()
  services.set(IDialogService, dialogService)

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
  const mainChannel = outputService.createChannel('Universe Editor')
  mainChannel.appendLine('[Workbench] Starting up…')

  // Advance to Ready before mounting React (triggers BlockRestore contributions)
  lifecycle.setPhase(LifecyclePhase.Ready)

  // Mount
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('[bootstrap] #root element not found')

  createRoot(rootEl).render(
    <StrictMode>
      <Workbench instantiation={instantiation} lifecycle={lifecycle} />
    </StrictMode>,
  )
}

bootstrapWorkbench()
