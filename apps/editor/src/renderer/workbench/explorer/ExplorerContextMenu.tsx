/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerContextMenu — thin wrapper that delegates to the workbench-ui ContextMenu.
 *  Items come from MenuRegistry (ExplorerMenuContribution registers them at BlockStartup).
 *--------------------------------------------------------------------------------------------*/

import { type ICommandService, MenuId } from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import type { URI } from '@universe-editor/platform'

export interface ContextMenuState {
  readonly x: number
  readonly y: number
  /** Null when the user right-clicked an empty area; commands fall back to root. */
  readonly target: { resource: URI; isDirectory: boolean } | null
}

interface Props {
  readonly state: ContextMenuState
  readonly rootResource: URI
  readonly commandService: ICommandService
  readonly onClose: () => void
}

export function ExplorerContextMenu({ state, rootResource, commandService, onClose }: Props) {
  // Resolve the target for commands: clicked item, or its parent dir, or the root.
  const target = state.target
  const effectiveTarget = target ?? { resource: rootResource, isDirectory: true }

  return (
    <ContextMenu
      menuId={MenuId.ExplorerContext}
      anchor={{ x: state.x, y: state.y }}
      args={[effectiveTarget]}
      commandService={commandService}
      onClose={onClose}
    />
  )
}
