/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Built-in workbench contributions. Importing this module registers every
 *  contribution with `ContributionsRegistry`; `ContributionService` then
 *  instantiates them as the lifecycle phase advances.
 *--------------------------------------------------------------------------------------------*/

import { ContributionsRegistry, WorkbenchPhase } from '@universe-editor/platform'
// Side-effect: registers all built-in Action2's with the global registries.
import '../actions/index.js'
import { BuiltInViewContainersContribution } from './BuiltInViewContainersContribution.js'
import { ContextKeyContribution } from './ContextKeyContribution.js'
import { SettingsContribution } from './SettingsContribution.js'
import { StatusBarDefaultsContribution } from './StatusBarDefaultsContribution.js'

// ContextKey defaults must seed before any contribution evaluates a when-clause.
ContributionsRegistry.registerContribution(
  'workbench.contrib.contextKey',
  ContextKeyContribution,
  WorkbenchPhase.BlockStartup,
)

// ViewContainers need to exist before any UI tries to read them (ActivityBar
// derives its icons from the registry on first render), so register at startup.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInViewContainers',
  BuiltInViewContainersContribution,
  WorkbenchPhase.BlockStartup,
)

// Configuration schema must be registered before any UI consumes it (Settings
// editor reads `getConfigurationNodes()` on mount).
ContributionsRegistry.registerContribution(
  'workbench.contrib.settings',
  SettingsContribution,
  WorkbenchPhase.BlockStartup,
)

// Status bar defaults run after restore — the status bar is mounted by then.
ContributionsRegistry.registerContribution(
  'workbench.contrib.statusBarDefaults',
  StatusBarDefaultsContribution,
  WorkbenchPhase.AfterRestore,
)

export {
  BuiltInViewContainersContribution,
  ContextKeyContribution,
  SettingsContribution,
  StatusBarDefaultsContribution,
}
