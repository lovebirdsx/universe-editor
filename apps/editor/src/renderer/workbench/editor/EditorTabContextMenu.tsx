/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorTabContextMenu — the right-click menu on an editor tab. Wraps the
 *  workbench-ui ContextMenu with a scoped ContextKeyService that mirrors the
 *  *clicked* tab (its editor type + resource scheme), so `when`-clauses gate
 *  each entry against the tab under the cursor rather than showing everything
 *  unconditionally. Reads fall back to the root context, so Close-group
 *  preconditions (hasActiveEditor / editorIsOpen / …) still resolve correctly.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import {
  MenuId,
  type ICommandService,
  type IContextKeyService,
  type URI,
} from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import { useScopedContextKey } from '../useScopedContextKey.js'

interface Props {
  readonly x: number
  readonly y: number
  readonly groupId: number
  readonly editorId: string
  readonly editorType: string
  readonly resource: URI | null
  readonly commandService: ICommandService
  readonly contextKeyService: IContextKeyService
  readonly onClose: () => void
}

export function EditorTabContextMenu({
  x,
  y,
  groupId,
  editorId,
  editorType,
  resource,
  commandService,
  contextKeyService,
  onClose,
}: Props) {
  const resourceScheme = resource?.scheme ?? ''
  const scopedContext = useScopedContextKey(contextKeyService, {
    activeEditorType: editorType,
    resourceScheme,
  })

  const args = useMemo(
    () => [{ groupId, editorId, resource: resource?.toJSON() ?? undefined }],
    [groupId, editorId, resource],
  )

  return (
    <ContextMenu
      menuId={MenuId.EditorTabContext}
      anchor={{ x, y }}
      args={args}
      commandService={commandService}
      contextKeyService={scopedContext}
      onClose={onClose}
    />
  )
}
