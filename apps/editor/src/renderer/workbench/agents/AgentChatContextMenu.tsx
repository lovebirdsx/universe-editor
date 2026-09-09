/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentChatContextMenu — thin wrapper that delegates to the workbench-ui ContextMenu.
 *  Items come from MenuRegistry (the agent Action2s register them via their `menu` field).
 *--------------------------------------------------------------------------------------------*/

import { type ICommandService, type IContextKeyService, MenuId } from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'
import { renderMenuIcon } from '../icons/menuIcon.js'

export interface AgentChatContextMenuState {
  readonly x: number
  readonly y: number
  readonly args?: readonly unknown[]
  /** True when raised by the ContextMenu key / Shift+F10 — the menu opens with
   *  its first row highlighted (VSCode parity), since a keyboard user has no
   *  pointer to aim. */
  readonly keyboard?: boolean
  /** Coarse target shape (`image` / `path` / `text` / chip kind) the "last
   *  executed" memory is bucketed under — see ContextMenu's `contextTag`. */
  readonly contextTag?: string
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
  const memory = useContextMenuMemory()

  return (
    <ContextMenu
      menuId={menuId ?? MenuId.AcpChatContext}
      anchor={{ x: state.x, y: state.y }}
      {...(state.args !== undefined ? { args: state.args } : {})}
      commandService={commandService}
      {...(contextKeyService !== undefined ? { contextKeyService } : {})}
      autoFocusFirst={state.keyboard ?? false}
      {...(memory ? { memory } : {})}
      {...(state.contextTag !== undefined ? { contextTag: state.contextTag } : {})}
      renderIcon={renderMenuIcon}
      onClose={onClose}
    />
  )
}
