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
 *  Zero imports on purpose: `actions/` and `workbench/scm/` both reference it.
 *--------------------------------------------------------------------------------------------*/

export const SCM_OPEN_FILE_COMMAND = 'workbench.action.scm.openFile'
export const SCM_OPEN_PREVIEW_COMMAND = 'workbench.action.scm.openPreview'

/** Row commands the hover strip renders ahead of the `inline` group. The array
 *  order is the strip's render order; the right-click menu orders the same two
 *  by their `1_open` order instead. */
export const SCM_HOVER_LEADING_COMMANDS: readonly string[] = [
  SCM_OPEN_PREVIEW_COMMAND,
  SCM_OPEN_FILE_COMMAND,
]
