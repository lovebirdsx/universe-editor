/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  scmRowCommands — the host-owned SCM resource-row commands, and where the row
 *  hover strip finds them.
 *
 *  Both are contributed to `scm/resourceState/context` in the right-click menu's
 *  `1_open` group (VSCode orders "open" first), which is not the `inline` group
 *  the hover strip renders. The strip therefore picks them out by command id,
 *  so one menu contribution still backs both surfaces — the two hard-coded
 *  buttons this replaces were invisible to every context menu.
 *
 *  No runtime imports on purpose: `actions/` and `workbench/scm/` both reference it.
 *--------------------------------------------------------------------------------------------*/

import type { OpenTarget } from '../editor/openTarget.js'

export const SCM_OPEN_FILE_COMMAND = 'workbench.action.scm.openFile'
export const SCM_OPEN_PREVIEW_COMMAND = 'workbench.action.scm.openPreview'

/** Row commands the hover strip renders ahead of the `inline` group. The array
 *  order is the strip's render order; the right-click menu orders the same two
 *  by their `1_open` order instead. */
export const SCM_HOVER_LEADING_COMMANDS: readonly string[] = [
  SCM_OPEN_PREVIEW_COMMAND,
  SCM_OPEN_FILE_COMMAND,
]

/** SCM row commands owned by an extension host that accept the trailing
 *  `{ openTarget }` options bag. Explicit whitelist: not every `1_open`
 *  command does (`perforce-graph.viewFileHistory` shares the group but takes
 *  no options). `git.openFile` / `perforce.openFile` accept options too, but
 *  are not part of scm/resourceState/context today. */
export const SCM_TARGETED_OPEN_COMMANDS: ReadonlySet<string> = new Set([
  'git.openChange',
  'git.openMergeEditor',
  'perforce.openChange',
  'perforce.openMergeEditor',
  'perforce.openShelvedFile',
])

/** Arguments for a whitelisted row command: shelved rows bring their own
 *  payload (changelist + depot path) instead of the resource DTO, and the
 *  target rides last because extension hosts cannot read the renderer's
 *  ambient modifiers. */
export function scmTargetedOpenArgs(
  explicit: readonly unknown[] | undefined,
  primary: unknown,
  openTarget: OpenTarget,
): unknown[] {
  const args = explicit && explicit.length > 0 ? [...explicit] : [primary]
  return openTarget === 'default' ? args : [...args, { openTarget }]
}
