/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Eventually-phase contribution registrations. Importing this module (side
 *  effect) registers every Eventually contribution with `ContributionsRegistry`.
 *--------------------------------------------------------------------------------------------*/

import { ContributionsRegistry, WorkbenchPhase } from '@universe-editor/platform'
import { AgentBinaryPrefetchContribution } from '../AgentBinaryPrefetchContribution.js'
import { ExtensionsContribution } from '../ExtensionsContribution.js'
import { LanguageServicePrewarmContribution } from '../LanguageServicePrewarmContribution.js'
import { StartupTimingLogContribution } from '../StartupTimingLogContribution.js'
import { WorkspaceWatchContribution } from '../WorkspaceWatchContribution.js'

// Idle-time background prefetch of the Claude / codex-acp binaries so upgrading
// is instant. Eventually so it never competes with startup work; the fetch only
// kicks off once the host reports idle.
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentBinaryPrefetch',
  AgentBinaryPrefetchContribution,
  WorkbenchPhase.Eventually,
)

// Extension system: spawn the extension host + connect the RPC. Eventually so it
// never blocks first paint; contributed UI is translated into the kernel
// registries before activation in later phases.
ContributionsRegistry.registerContribution(
  'workbench.contrib.extensions',
  ExtensionsContribution,
  WorkbenchPhase.Eventually,
)

// TS/JS language features (providers / document sync / diagnostics) now live in
// the built-in `extensions/typescript` plugin, which self-spawns the
// typescript-language-server and registers through the languages API.

// Idle prewarm of configured language services (default: typescript, markdown)
// so the first file of each language opens without a cold-start delay. Depends
// on the extension host being up, hence Eventually + runWhenIdle.
ContributionsRegistry.registerContribution(
  'workbench.contrib.languageServicePrewarm',
  LanguageServicePrewarmContribution,
  WorkbenchPhase.Eventually,
)

// Cold-start Explorer watcher: arms the parcel recursive subscribe once the
// workbench is idle, well after first mount. See WorkspaceWatchContribution.
ContributionsRegistry.registerContribution(
  'workbench.contrib.workspaceWatch',
  WorkspaceWatchContribution,
  WorkbenchPhase.Eventually,
)

// Logs one startup timeline (tagged post-update or steady-state) to the shared
// main log after mount, so a slow first launch right after an auto-update is
// measurable without opening the Startup Performance report on that launch.
ContributionsRegistry.registerContribution(
  'workbench.contrib.startupTimingLog',
  StartupTimingLogContribution,
  WorkbenchPhase.Eventually,
)
