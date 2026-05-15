import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ServiceCollection,
  InstantiationService,
  LifecycleService,
  LifecyclePhase,
  ILifecycleService,
  ICommandService,
  IEditorService,
  IStatusBarService,
  IViewsService,
  IQuickInputService,
  IOutputService,
  ILayoutService,
  IHostService,
  IIpcService,
  IStorageService,
  ContributionService,
  IContributionService,
  KeybindingsRegistry,
  CommandsRegistry,
  MenuRegistry,
  MenuId,
  StatusBarAlignment,
  ViewContainerRegistry,
  ViewContainerLocation,
  PartId,
  ProxyChannel,
  normalizePlatform,
} from '@universe-editor/platform'
import { ServiceChannels } from '../shared/ipc/channelNames.js'
import { IPingService } from '../shared/ipc/services.js'
import { createRendererIpcService } from './ipc/bootstrap.js'
import { Workbench } from './workbench/Workbench.js'
import { CommandService } from './workbench/CommandService.js'
import { EditorService } from './workbench/editor/EditorService.js'
import { StatusBarService } from './workbench/statusbar/StatusBarService.js'
import { ViewsService } from './workbench/sidebar/ViewsService.js'
import { QuickInputService } from './workbench/quickinput/QuickInputService.js'
import { OutputService } from './workbench/panel/output/OutputService.js'
import { LayoutService } from './workbench/layout/LayoutService.js'
import './workbench.css'

interface BuiltInDeps {
  lifecycle: LifecycleService
  statusBar: StatusBarService
  layoutService: LayoutService
  viewsService: ViewsService
  quickInputService: QuickInputService
  commandService: CommandService
}

function registerBuiltInContributions(deps: BuiltInDeps): void {
  const { lifecycle, statusBar, layoutService, viewsService, quickInputService, commandService } =
    deps

  // -- Commands + keybindings --

  CommandsRegistry.registerCommand(
    'workbench.action.toggleSidebarVisibility',
    () => layoutService.toggleVisible(PartId.SideBar),
    { description: 'Toggle Primary Side Bar', category: 'View' },
  )
  KeybindingsRegistry.registerKeybinding({
    key: 'ctrl+b',
    command: 'workbench.action.toggleSidebarVisibility',
  })

  CommandsRegistry.registerCommand(
    'workbench.action.toggleSecondarySidebarVisibility',
    () => {
      layoutService.toggleVisible(PartId.SecondarySideBar)
      if (layoutService.getVisible(PartId.SecondarySideBar)) {
        const activeId = viewsService.getActiveViewContainerId(
          ViewContainerLocation.SecondarySideBar,
        )
        if (!activeId) viewsService.openViewContainer('workbench.view.outline')
      }
    },
    { description: 'Toggle Secondary Side Bar', category: 'View' },
  )
  KeybindingsRegistry.registerKeybinding({
    key: 'ctrl+alt+b',
    command: 'workbench.action.toggleSecondarySidebarVisibility',
  })

  CommandsRegistry.registerCommand(
    'workbench.action.togglePanel',
    () => layoutService.toggleVisible(PartId.Panel),
    { description: 'Toggle Panel', category: 'View' },
  )
  KeybindingsRegistry.registerKeybinding({
    key: 'ctrl+j',
    command: 'workbench.action.togglePanel',
  })

  CommandsRegistry.registerCommand(
    'workbench.action.showCommands',
    async () => {
      const commands = [...CommandsRegistry.getCommands().values()].map((cmd) => ({
        id: cmd.id,
        label: cmd.metadata?.description ?? cmd.id,
        ...(cmd.metadata?.category !== undefined ? { description: cmd.metadata.category } : {}),
      }))
      const selected = await quickInputService.pick(commands, {
        id: 'workbench.commandPalette',
        placeholder: 'Type a command name…',
      })
      if (selected) {
        void commandService.executeCommand(selected.id)
      }
    },
    { description: 'Show All Commands', category: 'View' },
  )
  KeybindingsRegistry.registerKeybinding({
    key: 'ctrl+shift+p',
    command: 'workbench.action.showCommands',
  })

  // -- Menu placements --

  MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
    command: 'workbench.action.showCommands',
    group: '1_open',
    order: 1,
  })
  MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
    command: 'workbench.action.toggleSidebarVisibility',
    group: '2_layout',
    order: 1,
  })
  MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
    command: 'workbench.action.toggleSecondarySidebarVisibility',
    group: '2_layout',
    order: 2,
  })
  MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
    command: 'workbench.action.togglePanel',
    group: '2_layout',
    order: 3,
  })

  MenuRegistry.addMenuItem(MenuId.CommandPalette, {
    command: 'workbench.action.showCommands',
  })
  MenuRegistry.addMenuItem(MenuId.CommandPalette, {
    command: 'workbench.action.toggleSidebarVisibility',
  })
  MenuRegistry.addMenuItem(MenuId.CommandPalette, {
    command: 'workbench.action.toggleSecondarySidebarVisibility',
  })
  MenuRegistry.addMenuItem(MenuId.CommandPalette, {
    command: 'workbench.action.togglePanel',
  })

  // Default status bar entries (added when lifecycle reaches Ready)
  void lifecycle.when(LifecyclePhase.Ready).then(() => {
    statusBar.addEntry({
      text: 'Status Bar',
      tooltip: 'This is the status bar',
      alignment: StatusBarAlignment.Right,
      priority: 100,
    })
  })

  // Built-in Explorer view container
  ViewContainerRegistry.registerViewContainer({
    id: 'workbench.view.explorer',
    label: 'Explorer',
    icon: 'files',
    order: 1,
    location: ViewContainerLocation.SideBar,
  })

  // Built-in Outline view container (secondary sidebar)
  ViewContainerRegistry.registerViewContainer({
    id: 'workbench.view.outline',
    label: 'Outline',
    icon: 'search',
    order: 1,
    location: ViewContainerLocation.SecondarySideBar,
  })
}

function bootstrapWorkbench(): void {
  const services = new ServiceCollection()

  // Platform services
  const lifecycle = new LifecycleService()
  services.set(ILifecycleService, lifecycle)

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

  // Create the DI container (registers itself as IInstantiationService)
  const instantiation = new InstantiationService(services)

  // Renderer-only service implementations (pure local state, no IPC).
  const editorService = new EditorService()
  const statusBarService = new StatusBarService()
  const viewsService = new ViewsService()
  const outputService = new OutputService()
  const commandService = new CommandService(instantiation)

  services.set(ICommandService, commandService)
  services.set(IEditorService, editorService)
  services.set(IStatusBarService, statusBarService)
  services.set(IViewsService, viewsService)
  services.set(IOutputService, outputService)

  // Services with @IStorageService dependencies go through DI.
  const quickInputService = instantiation.createInstance(QuickInputService)
  services.set(IQuickInputService, quickInputService)
  const layoutService = instantiation.createInstance(LayoutService)
  services.set(ILayoutService, layoutService)

  // Contribution service wires lifecycle → contributions auto-start
  const contributionService = new ContributionService(lifecycle, instantiation)
  services.set(IContributionService, contributionService)

  // Register built-in contributions
  registerBuiltInContributions({
    lifecycle,
    statusBar: statusBarService,
    layoutService,
    viewsService,
    quickInputService,
    commandService,
  })

  // Create default output channel
  const mainChannel = outputService.createChannel('Universe Editor')
  mainChannel.appendLine('[Workbench] Starting up…')

  // Advance to Ready before mounting React
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
