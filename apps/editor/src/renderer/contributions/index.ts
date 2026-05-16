/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Built-in workbench contributions. Importing this module registers every
 *  contribution with `ContributionsRegistry`; `ContributionService` then
 *  instantiates them as the lifecycle phase advances.
 *--------------------------------------------------------------------------------------------*/

import { ContributionsRegistry, WorkbenchPhase } from '@universe-editor/platform'
import { BuiltInViewContainersContribution } from './BuiltInViewContainersContribution.js'
import { CommandPaletteContribution } from './CommandPaletteContribution.js'
import { LayoutCommandsContribution } from './LayoutCommandsContribution.js'
import { MenuPlacementsContribution } from './MenuPlacementsContribution.js'
import { StatusBarDefaultsContribution } from './StatusBarDefaultsContribution.js'

// ViewContainers need to exist before any UI tries to read them (ActivityBar
// derives its icons from the registry on first render), so register at startup.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInViewContainers',
  BuiltInViewContainersContribution,
  WorkbenchPhase.BlockStartup,
)

// Commands + keybindings + menus can be registered before the window appears.
ContributionsRegistry.registerContribution(
  'workbench.contrib.layoutCommands',
  LayoutCommandsContribution,
  WorkbenchPhase.BlockRestore,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.commandPalette',
  CommandPaletteContribution,
  WorkbenchPhase.BlockRestore,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.menuPlacements',
  MenuPlacementsContribution,
  WorkbenchPhase.BlockRestore,
)

// Status bar defaults run after restore — the status bar is mounted by then.
ContributionsRegistry.registerContribution(
  'workbench.contrib.statusBarDefaults',
  StatusBarDefaultsContribution,
  WorkbenchPhase.AfterRestore,
)

export {
  BuiltInViewContainersContribution,
  CommandPaletteContribution,
  LayoutCommandsContribution,
  MenuPlacementsContribution,
  StatusBarDefaultsContribution,
}
