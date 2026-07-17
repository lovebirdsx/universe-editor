/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorTabContextMenu — the right-click menu on an editor tab. Wraps the
 *  workbench-ui ContextMenu with a scoped ContextKeyService that mirrors the
 *  *clicked* tab (its editor type + resource scheme), so `when`-clauses gate
 *  each entry against the tab under the cursor rather than showing everything
 *  unconditionally. Reads fall back to the root context, so Close-group
 *  preconditions (hasActiveEditor / editorIsOpen / …) still resolve correctly.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo } from 'react'
import {
  markAsSingleton,
  MenuId,
  type ICommandService,
  type IContextKeyService,
  type URI,
} from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'

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

  const scopedContext = useMemo(
    () =>
      markAsSingleton(
        contextKeyService.createScoped({
          activeEditorType: editorType,
          resourceScheme,
        }),
      ),
    [contextKeyService, editorType, resourceScheme],
  )

  useEffect(() => () => scopedContext.dispose(), [scopedContext])

  return (
    <ContextMenu
      menuId={MenuId.EditorTabContext}
      anchor={{ x, y }}
      args={[
        {
          groupId,
          editorId,
          resource: resource?.toJSON() ?? undefined,
        },
      ]}
      commandService={commandService}
      contextKeyService={scopedContext}
      onClose={onClose}
    />
  )
}
