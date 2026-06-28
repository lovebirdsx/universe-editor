/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Eventually-phase contribution registrations. Importing this module (side
 *  effect) registers every Eventually contribution with `ContributionsRegistry`.
 *--------------------------------------------------------------------------------------------*/

import { ContributionsRegistry, WorkbenchPhase } from '@universe-editor/platform'
import { AgentBinaryPrefetchContribution } from '../AgentBinaryPrefetchContribution.js'
import { ExtensionsContribution } from '../ExtensionsContribution.js'

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
