/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupContextMenu — right-click menu on the tab bar background (or the
 *  empty editor area). It targets the group it was opened on, mirroring VSCode's
 *  `EditorTabsBarContext`: Move/Copy Group into New Window operate on that
 *  group, not on the workbench-active editor. Menu entries also resolve against
 *  that group's scoped context, so a future `when` cannot silently read another
 *  group's active editor.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { MenuId, type ICommandService, type IEditorGroup } from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'
import { useEditorGroupScopedContextKey } from './useEditorGroupScopedContextKey.js'

interface Props {
  readonly x: number
  readonly y: number
  readonly group: IEditorGroup
  /** Raised with the ContextMenu key — the menu opens on its first entry. */
  readonly keyboard: boolean
  readonly targetDocument?: Document | undefined
  readonly commandService: ICommandService
  readonly onClose: () => void
}

export function EditorGroupContextMenu({
  x,
  y,
  group,
  keyboard,
  targetDocument,
  commandService,
  onClose,
}: Props) {
  const contextKeyService = useEditorGroupScopedContextKey(group)
  const args = useMemo(() => [{ groupId: group.id }], [group.id])
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
