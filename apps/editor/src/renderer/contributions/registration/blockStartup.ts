/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  BlockStartup-phase contribution registrations. Importing this module (side
 *  effect) registers every BlockStartup contribution with `ContributionsRegistry`.
 *--------------------------------------------------------------------------------------------*/

import { ContributionsRegistry, WorkbenchPhase } from '@universe-editor/platform'
import { MonacoOverrideServicesContribution } from '../MonacoOverrideServicesContribution.js'
import { ContextKeyContribution } from '../ContextKeyContribution.js'
import { FocusContextKeyContribution } from '../FocusContextKeyContribution.js'
import { WorkbenchPartsContribution } from '../WorkbenchPartsContribution.js'
import { ConfigInitContribution } from '../ConfigInitContribution.js'
import { AcpInitContribution } from '../AcpInitContribution.js'
import { BuiltInEditorProvidersContribution } from '../BuiltInEditorProvidersContribution.js'
import { BuiltInViewContainersContribution } from '../BuiltInViewContainersContribution.js'
import { BuiltInViewsContribution } from '../BuiltInViewsContribution.js'
import { ExtensionsViewContribution } from '../ExtensionsViewContribution.js'
import { SettingsContribution } from '../SettingsContribution.js'
import { ThemeContribution } from '../ThemeContribution.js'
import { AiConfigurationContribution } from '../AiConfigurationContribution.js'
import { StatusBarComponentsContribution } from '../StatusBarComponentsContribution.js'
import { WorkbenchFontContribution } from '../WorkbenchFontContribution.js'
import { AgentFontContribution } from '../AgentFontContribution.js'
import { JsonSchemaBridgeContribution } from '../JsonSchemaBridgeContribution.js'
import { JsonSchemaAssociationsContribution } from '../JsonSchemaAssociationsContribution.js'
import { InlineCompletionConfigurationContribution } from '../InlineCompletionConfigurationContribution.js'
import { MarkdownConfigurationContribution } from '../MarkdownConfigurationContribution.js'
import { BuiltInEditorBindingsContribution } from '../BuiltInEditorBindingsContribution.js'
import { ExplorerClipboardContextContribution } from '../ExplorerClipboardContextContribution.js'
import { CompareContextContribution } from '../CompareContextContribution.js'
import { ExplorerFileConfigurationContribution } from '../ExplorerFileConfigurationContribution.js'
import { ExplorerMenuContribution } from '../ExplorerMenuContribution.js'
import { EditMenuContribution } from '../EditMenuContribution.js'
import { LogLevelContribution } from '../LogLevelContribution.js'
import {
  AgentsConfigurationContribution,
  AgentsEditorProviderContribution,
  AgentsViewContainerContribution,
} from '../AgentsContributions.js'
import { QuickAccessContribution } from '../QuickAccessContribution.js'
import { SearchPersistenceContribution } from '../SearchPersistenceContribution.js'

// Install the Monaco standalone override services (cross-file rename writer +
// references text-model resolver) on MonacoLoader before any editor is created —
// Monaco standalone locks overrides in on first init. BlockStartup runs well
// ahead of the first editor.create during restore.
ContributionsRegistry.registerContribution(
  'workbench.contrib.monacoOverrideServices',
  MonacoOverrideServicesContribution,
  WorkbenchPhase.BlockStartup,
)

// ContextKey defaults must seed before any contribution evaluates a when-clause.
ContributionsRegistry.registerContribution(
  'workbench.contrib.contextKey',
  ContextKeyContribution,
  WorkbenchPhase.BlockStartup,
)

// Focus-related context keys. BlockStartup so when-clauses involving
// focusedPart/focusedView/sideBarFocus/etc. resolve correctly from the very
// first command dispatch.
ContributionsRegistry.registerContribution(
  'workbench.contrib.focusContextKey',
  FocusContextKeyContribution,
  WorkbenchPhase.BlockStartup,
)

// Instantiate the six workbench Parts (they self-register with the
// LayoutService on construction) and bridge the FocusTracker to each Part.
// BlockStartup so getPart()/getParts() resolve before any React paint.
ContributionsRegistry.registerContribution(
  'workbench.contrib.workbenchParts',
  WorkbenchPartsContribution,
  WorkbenchPhase.BlockStartup,
)

// Kick off file-backed settings.json / keybindings.json loads. BlockStartup so
// the User config + keybinding layers are in flight before UI paint; both loads
// are async fire-and-forget and refresh subscribers via change events.
ContributionsRegistry.registerContribution(
  'workbench.contrib.configInit',
  ConfigInitContribution,
  WorkbenchPhase.BlockStartup,
)

// Hydrate ACP persisted state (session history / per-agent defaults / chat
// location). BlockStartup so hydration is in flight before session restore
// (AfterRestore) and before any createSession; all initialize() calls are
// fire-and-forget.
ContributionsRegistry.registerContribution(
  'workbench.contrib.acpInit',
  AcpInitContribution,
  WorkbenchPhase.BlockStartup,
)

// Built-in editor providers must be registered before WorkspaceRestoreContribution
// (BlockRestore) calls _restore(). EditorArea.tsx lives in the Workbench dynamic
// chunk which loads after setPhase(Ready), so we cannot rely on its module-level
// side-effects being present when _restore() resolves its storage IPC call.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInEditorProviders',
  BuiltInEditorProvidersContribution,
  WorkbenchPhase.BlockStartup,
)

// ViewContainers need to exist before any UI tries to read them (ActivityBar
// derives its icons from the registry on first render), so register at startup.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInViewContainers',
  BuiltInViewContainersContribution,
  WorkbenchPhase.BlockStartup,
)

// Built-in views — Explorer file tree etc. Each view's descriptor + React
// component are registered together (single-point) so the SideBar finds them on
// first paint. Register alongside the containers.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInViews',
  BuiltInViewsContribution,
  WorkbenchPhase.BlockStartup,
)

// Extensions viewlet (Activity Bar container + view). Registered alongside the
// other containers so its icon appears on first paint.
ContributionsRegistry.registerContribution(
  'workbench.contrib.extensionsView',
  ExtensionsViewContribution,
  WorkbenchPhase.BlockStartup,
)

// Configuration schema must be registered before any UI consumes it (Settings
// editor reads `getConfigurationNodes()` on mount).
ContributionsRegistry.registerContribution(
  'workbench.contrib.settings',
  SettingsContribution,
  WorkbenchPhase.BlockStartup,
)

ContributionsRegistry.registerContribution(
  'workbench.contrib.theme',
  ThemeContribution,
  WorkbenchPhase.BlockStartup,
)

// JSON schema for aiSettings.json (provider groups + active model selections,
// the latter with model-id completion). No API keys — those live in encrypted
// secret storage. BlockStartup so the schema is registered before the AI client
// or any aiSettings.json editor reads it.
ContributionsRegistry.registerContribution(
  'workbench.contrib.aiConfiguration',
  AiConfigurationContribution,
  WorkbenchPhase.BlockStartup,
)

// Status-bar componentKey → React component bindings. BlockStartup so the mapping
// exists before the status bar first paints.
ContributionsRegistry.registerContribution(
  'workbench.contrib.statusBarComponents',
  StatusBarComponentsContribution,
  WorkbenchPhase.BlockStartup,
)

ContributionsRegistry.registerContribution(
  'workbench.contrib.workbenchFont',
  WorkbenchFontContribution,
  WorkbenchPhase.BlockStartup,
)

// Agent chat panel font (acp.fontSize / acp.fontFamily) → scoped CSS variables
// consumed by `.chat`. BlockStartup so the panel paints at the configured size.
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentFont',
  AgentFontContribution,
  WorkbenchPhase.BlockStartup,
)

// JSON Schema bridge — derives schemas for settings.json / keybindings.json
// from the live ConfigurationRegistry / CommandsRegistry and feeds them to
// Monaco's JSON language service. BlockStartup so the schemas are ready
// before any settings.json editor opens.
ContributionsRegistry.registerContribution(
  'workbench.contrib.jsonSchemaBridge',
  JsonSchemaBridgeContribution,
  WorkbenchPhase.BlockStartup,
)

// JSON schema associations from the built-in declaration table + the user
// `json.schemas` setting. Funnels into the same JSONContributionRegistry the
// bridge consumes. BlockStartup so associations are registered before any JSON
// editor opens.
ContributionsRegistry.registerContribution(
  'workbench.contrib.jsonSchemaAssociations',
  JsonSchemaAssociationsContribution,
  WorkbenchPhase.BlockStartup,
)

// AI inline completions. The config schema must register early (BlockStartup) so
// the Settings editor sees it; the Monaco provider + status bar come up
// AfterRestore once Monaco and the status bar exist.
ContributionsRegistry.registerContribution(
  'workbench.contrib.inlineCompletionConfiguration',
  InlineCompletionConfigurationContribution,
  WorkbenchPhase.BlockStartup,
)

ContributionsRegistry.registerContribution(
  'workbench.contrib.markdownConfiguration',
  MarkdownConfigurationContribution,
  WorkbenchPhase.BlockStartup,
)

// Explorer / files settings (delete-to-trash, confirm-delete, enable-undo) +
// the explorerEnableUndo context key. BlockStartup so the Settings editor sees
// the schema and the keybinding gate is set before the Explorer mounts.
ContributionsRegistry.registerContribution(
  'workbench.contrib.explorerFileConfiguration',
  ExplorerFileConfigurationContribution,
  WorkbenchPhase.BlockStartup,
)

// Default glob → EditorInput bindings + "Reopen With..." menu item.
// BlockStartup so the catch-all '**/*' → FileEditorInput registration exists
// before ExplorerView or any other caller opens a file.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInEditorBindings',
  BuiltInEditorBindingsContribution,
  WorkbenchPhase.BlockStartup,
)

// Explorer right-click menu items registered through MenuRegistry.
// BlockStartup so they are available before any ExplorerContextMenu renders.
ContributionsRegistry.registerContribution(
  'workbench.contrib.explorerClipboardContext',
  ExplorerClipboardContextContribution,
  WorkbenchPhase.BlockStartup,
)

ContributionsRegistry.registerContribution(
  'workbench.contrib.compareContext',
  CompareContextContribution,
  WorkbenchPhase.BlockStartup,
)

ContributionsRegistry.registerContribution(
  'workbench.contrib.explorerMenu',
  ExplorerMenuContribution,
  WorkbenchPhase.BlockStartup,
)

// Edit menu (Undo/Redo/Cut/Copy/Paste/Select All/Find/Replace). BlockStartup so
// the menubar structure is in place before the title bar first renders.
ContributionsRegistry.registerContribution(
  'workbench.contrib.editMenu',
  EditMenuContribution,
  WorkbenchPhase.BlockStartup,
)

// Apply persisted `logging.level` to the renderer + main loggers as early as
// possible so the configured level is in effect before bulk restore traffic.
ContributionsRegistry.registerContribution(
  'workbench.contrib.logLevel',
  LogLevelContribution,
  WorkbenchPhase.BlockStartup,
)

// ACP integration: configuration schema, view container/views, editor provider
// (BlockStartup); status-bar entry runs after the workbench mounts.
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsConfiguration',
  AgentsConfigurationContribution,
  WorkbenchPhase.BlockStartup,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsViewContainer',
  AgentsViewContainerContribution,
  WorkbenchPhase.BlockStartup,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsEditorProvider',
  AgentsEditorProviderContribution,
  WorkbenchPhase.BlockStartup,
)

// Register the QuickAccess provider descriptors (file / symbols / commands /
// workspace symbols) so workbench.action.quickOpen routes by input prefix.
// BlockStartup so the registry is populated before the first quick open.
ContributionsRegistry.registerContribution(
  'workbench.contrib.quickAccess',
  QuickAccessContribution,
  WorkbenchPhase.BlockStartup,
)

// Hydrate the Search viewlet's persisted view mode / history / exclude toggle from
// GLOBAL storage. BlockStartup so the view mode is restored before SearchView first
// paints (otherwise the tree flashes the default 'list' layout).
ContributionsRegistry.registerContribution(
  'workbench.contrib.searchPersistence',
  SearchPersistenceContribution,
  WorkbenchPhase.BlockStartup,
)
