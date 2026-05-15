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
} from '@universe-editor/platform'
import { Workbench } from './workbench/Workbench.js'
import { CommandService } from './workbench/CommandService.js'
import { EditorService } from './workbench/editor/EditorService.js'
import { StatusBarService } from './workbench/statusbar/StatusBarService.js'
import { ViewsService } from './workbench/sidebar/ViewsService.js'
import { QuickInputService } from './workbench/quickinput/QuickInputService.js'
import { OutputService } from './workbench/panel/output/OutputService.js'
import { LayoutService } from './workbench/layout/LayoutService.js'
import { HostService } from './workbench/host/HostService.js'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import './workbench.css'

interface BuiltInDeps {
  lifecycle: LifecycleService
  statusBar: StatusBarService
  layoutService: LayoutService
  quickInputService: QuickInputService
  commandService: CommandService
}

function registerBuiltInContributions(deps: BuiltInDeps): void {
  const { lifecycle, statusBar, layoutService, quickInputService, commandService } = deps

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
    command: 'workbench.action.togglePanel',
    group: '2_layout',
    order: 2,
  })

  MenuRegistry.addMenuItem(MenuId.CommandPalette, {
    command: 'workbench.action.showCommands',
  })
  MenuRegistry.addMenuItem(MenuId.CommandPalette, {
    command: 'workbench.action.toggleSidebarVisibility',
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
}

function bootstrapWorkbench(): void {
  const services = new ServiceCollection()

  // Platform services
  const lifecycle = new LifecycleService()
  services.set(ILifecycleService, lifecycle)

  // Create the DI container (registers itself as IInstantiationService)
  const instantiation = new InstantiationService(services)

  // Renderer-side service implementations
  const editorService = new EditorService()
  const statusBarService = new StatusBarService()
  const viewsService = new ViewsService()
  const quickInputService = new QuickInputService()
  const outputService = new OutputService()
  const layoutService = new LayoutService()
  const hostService = new HostService()
  const commandService = new CommandService(instantiation)

  services.set(ICommandService, commandService)
  services.set(IEditorService, editorService)
  services.set(IStatusBarService, statusBarService)
  services.set(IViewsService, viewsService)
  services.set(IQuickInputService, quickInputService)
  services.set(IOutputService, outputService)
  services.set(ILayoutService, layoutService)
  services.set(IHostService, hostService)

  // Contribution service wires lifecycle → contributions auto-start
  const contributionService = new ContributionService(lifecycle, instantiation)
  services.set(IContributionService, contributionService)

  // Register built-in contributions
  registerBuiltInContributions({
    lifecycle,
    statusBar: statusBarService,
    layoutService,
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
