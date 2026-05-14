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
  ContributionService,
  IContributionService,
  KeybindingsRegistry,
  CommandsRegistry,
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
import './workbench.css'

function registerBuiltInContributions(
  lifecycle: LifecycleService,
  statusBar: StatusBarService,
  layoutService: LayoutService,
): void {
  // Keybindings
  KeybindingsRegistry.registerKeybinding({
    key: 'ctrl+shift+p',
    command: 'workbench.action.showCommands',
  })
  KeybindingsRegistry.registerKeybinding({
    key: 'ctrl+`',
    command: 'workbench.action.togglePanel',
  })

  // Toggle panel command
  CommandsRegistry.registerCommand(
    'workbench.action.togglePanel',
    () => layoutService.toggleVisible(PartId.Panel),
    { description: 'Toggle Panel', category: 'View' },
  )

  // Toggle sidebar command
  CommandsRegistry.registerCommand(
    'workbench.action.toggleSidebar',
    () => layoutService.toggleVisible(PartId.SideBar),
    { description: 'Toggle Sidebar', category: 'View' },
  )

  // Default status bar entries (added when lifecycle reaches Ready)
  void lifecycle.when(LifecyclePhase.Ready).then(() => {
    statusBar.addEntry({
      text: '⎇ main',
      tooltip: 'Current branch',
      alignment: StatusBarAlignment.Left,
      priority: 100,
    })
    statusBar.addEntry({
      text: 'Universe Editor',
      alignment: StatusBarAlignment.Right,
      priority: 10,
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
  const commandService = new CommandService(instantiation)

  services.set(ICommandService, commandService)
  services.set(IEditorService, editorService)
  services.set(IStatusBarService, statusBarService)
  services.set(IViewsService, viewsService)
  services.set(IQuickInputService, quickInputService)
  services.set(IOutputService, outputService)
  services.set(ILayoutService, layoutService)

  // Contribution service wires lifecycle → contributions auto-start
  const contributionService = new ContributionService(lifecycle, instantiation)
  services.set(IContributionService, contributionService)

  // Register built-in contributions
  registerBuiltInContributions(lifecycle, statusBarService, layoutService)

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
