/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentChatContextMenu — thin wrapper that delegates to the workbench-ui ContextMenu.
 *  Items come from MenuRegistry (the agent Action2s register them via their `menu` field).
 *--------------------------------------------------------------------------------------------*/

import { type ICommandService, type IContextKeyService, MenuId } from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'

export interface AgentChatContextMenuState {
  readonly x: number
  readonly y: number
  readonly args?: readonly unknown[]
}

interface Props {
  readonly state: AgentChatContextMenuState
  readonly commandService: ICommandService
  readonly contextKeyService?: IContextKeyService
  /** Menu to populate from — defaults to the timeline menu; the prompt input's
   *  attachment chips use `MenuId.AcpPromptContext` instead. */
  readonly menuId?: MenuId
  readonly onClose: () => void
}

export function AgentChatContextMenu({
  state,
  commandService,
  contextKeyService,
  menuId,
  onClose,
}: Props) {
  return (
    <ContextMenu
      menuId={menuId ?? MenuId.AcpChatContext}
      anchor={{ x: state.x, y: state.y }}
      {...(state.args !== undefined ? { args: state.args } : {})}
      commandService={commandService}
      {...(contextKeyService !== undefined ? { contextKeyService } : {})}
      onClose={onClose}
    />
  )
}
