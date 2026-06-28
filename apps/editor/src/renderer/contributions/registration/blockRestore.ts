/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  BlockRestore-phase contribution registrations. Importing this module (side
 *  effect) registers every BlockRestore contribution with `ContributionsRegistry`.
 *--------------------------------------------------------------------------------------------*/

import { ContributionsRegistry, WorkbenchPhase } from '@universe-editor/platform'
import { AggregatedLogChannelContribution } from '../AggregatedLogChannelContribution.js'
import { WorkspaceRestoreContribution } from '../WorkspaceRestoreContribution.js'

// "All" aggregated Output channel — merges every log channel in time order so
// users can see cross-channel activity at a glance. BlockRestore so the All
// channel appears in the dropdown before AfterRestore contributions stream
// their first chunks (otherwise early appends are dropped while descriptors
// are being fetched).
ContributionsRegistry.registerContribution(
  'workbench.contrib.aggregatedLogChannel',
  AggregatedLogChannelContribution,
  WorkbenchPhase.BlockRestore,
)

// Editor groups must be rebuilt from storage BEFORE the React tree mounts the
// EditorArea, otherwise users see the default empty grid flash. BlockRestore
// runs at LifecyclePhase.Ready which the bootstrap toggles before mount.
ContributionsRegistry.registerContribution(
  'workbench.contrib.workspaceRestore',
  WorkspaceRestoreContribution,
  WorkbenchPhase.BlockRestore,
)
