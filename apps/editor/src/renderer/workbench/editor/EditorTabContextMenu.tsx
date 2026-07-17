/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorTabContextMenu — the right-click menu on an editor tab. Wraps the
 *  workbench-ui ContextMenu with a scoped ContextKeyService that mirrors the
 *  *clicked* tab (its editor type + resource scheme), so `when`-clauses gate
 *  each entry against the tab under the cursor rather than showing everything
 *  unconditionally. Reads fall back to the root context, so Close-group
 *  preconditions (hasActiveEditor / editorIsOpen / …) still resolve correctly.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useReducer, useRef } from 'react'
import {
  markAsSingleton,
  MenuId,
  type ICommandService,
  type IContextKeyService,
  type IScopedContextKeyService,
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
  const scopedRef = useRef<IScopedContextKeyService | null>(null)
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0)

  if (scopedRef.current === null) {
    scopedRef.current = markAsSingleton(
      contextKeyService.createScoped({ activeEditorType: editorType, resourceScheme }),
    )
  }

  useEffect(() => {
    // StrictMode's dev dry-run runs this effect's cleanup (disposing + nulling
    // the scoped service, which *clears its keys*) before the real mount. If we
    // don't recreate it, a later re-render re-evaluates each `resourceScheme ==
    // file` when-clause against an emptied context and every file command
    // silently vanishes, leaving only the unconditional Close group.
    if (scopedRef.current === null) {
      scopedRef.current = markAsSingleton(
        contextKeyService.createScoped({ activeEditorType: editorType, resourceScheme }),
      )
      forceUpdate()
    }
    return () => {
      scopedRef.current?.dispose()
      scopedRef.current = null
    }
  }, [contextKeyService, editorType, resourceScheme])

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
      contextKeyService={scopedRef.current}
      onClose={onClose}
    />
  )
}
