/*---------------------------------------------------------------------------------------------
 *  EditorGroupContextMenu — right-click menu on the tab bar background (or the
 *  empty editor area). It targets the group it was opened on, mirroring VSCode's
 *  `EditorTabsBarContext`: Move/Copy Group into New Window operate on that
 *  group, not on the workbench-active editor.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { MenuId, type ICommandService, type IContextKeyService } from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'

interface Props {
  readonly x: number
  readonly y: number
  readonly groupId: number
  /** Raised with the ContextMenu key — the menu opens on its first entry. */
  readonly keyboard: boolean
  readonly targetDocument?: Document | undefined
  readonly commandService: ICommandService
  readonly contextKeyService: IContextKeyService
  readonly onClose: () => void
}

export function EditorGroupContextMenu({
  x,
  y,
  groupId,
  keyboard,
  targetDocument,
  commandService,
  contextKeyService,
  onClose,
}: Props) {
  const args = useMemo(() => [{ groupId }], [groupId])
  const memory = useContextMenuMemory()

  return (
    <ContextMenu
      menuId={MenuId.EditorTabsBarContext}
      anchor={{ x, y }}
      args={args}
      commandService={commandService}
      contextKeyService={contextKeyService}
      renderIcon={renderMenuIcon}
      autoFocusFirst={keyboard}
      {...(targetDocument ? { targetDocument } : {})}
      {...(memory ? { memory } : {})}
      contextTag="editorGroup"
      onClose={onClose}
    />
  )
}
