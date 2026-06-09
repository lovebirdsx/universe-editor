/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentChatContextMenu — thin wrapper that delegates to the workbench-ui ContextMenu.
 *  Items come from MenuRegistry (the agent Action2s register them via their `menu` field).
 *--------------------------------------------------------------------------------------------*/

import { type ICommandService, MenuId } from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'

export interface AgentChatContextMenuState {
  readonly x: number
  readonly y: number
}

interface Props {
  readonly state: AgentChatContextMenuState
  readonly commandService: ICommandService
  readonly onClose: () => void
}

export function AgentChatContextMenu({ state, commandService, onClose }: Props) {
  return (
    <ContextMenu
      menuId={MenuId.AcpChatContext}
      anchor={{ x: state.x, y: state.y }}
      commandService={commandService}
      onClose={onClose}
    />
  )
}
