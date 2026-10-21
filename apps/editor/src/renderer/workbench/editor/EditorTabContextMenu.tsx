/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorTabContextMenu — the right-click menu on an editor tab. Wraps the
 *  workbench-ui ContextMenu with a scoped ContextKeyService seeded from the
 *  *clicked* tab (editor type, resource scheme, position in the group, pin and
 *  dirty state, …), so every `when`/precondition gates each entry against the
 *  tab under the cursor rather than the workbench-active editor.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import {
  IUriIdentityService,
  MenuId,
  type EditorInput,
  type ICommandService,
  type IContextKeyService,
  type IEditorGroup,
} from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'
import { useRemoteAuthority } from '../useRemoteAuthority.js'
import { useOptionalService } from '../useService.js'
import { useScopedContextKey } from '../useScopedContextKey.js'
import { IDirtyDiffNavigationService } from '../../services/scm/DirtyDiffNavigationService.js'
import { IScmDecorationsService } from '../../services/scm/ScmDecorationsService.js'
import { IScmService } from '../../services/extensions/ScmService.js'
import { editorScopedContextValues } from './editorScopedContext.js'
import { tabContextMenuResource } from './tabContextMenuResource.js'

interface Props {
  readonly x: number
  readonly y: number
  readonly group: IEditorGroup
  readonly editor: EditorInput
  /** Raised with the ContextMenu key — the menu opens on its first entry. */
  readonly keyboard: boolean
  readonly targetDocument?: Document | undefined
  readonly commandService: ICommandService
  readonly contextKeyService: IContextKeyService
  readonly onClose: () => void
}

export function EditorTabContextMenu({
  x,
  y,
  group,
  editor,
  keyboard,
  targetDocument,
  commandService,
  contextKeyService,
  onClose,
}: Props) {
  const resource = tabContextMenuResource(editor)
  const editorType = editor.typeId
  const uriIdentity = useOptionalService(IUriIdentityService)
  const dirtyDiff = useOptionalService(IDirtyDiffNavigationService)
  const scmDecorations = useOptionalService(IScmDecorationsService)
  const scmService = useOptionalService(IScmService)
  const remoteAuthority = useRemoteAuthority()
  const scopedContext = useScopedContextKey(
    contextKeyService,
    editorScopedContextValues(group, editor, {
      resource,
      uriIdentity,
      dirtyDiff,
      scmDecorations,
      scmService,
      remoteAuthority,
    }),
  )
  const memory = useContextMenuMemory()

  const args = useMemo(
    () => [{ groupId: group.id, editorId: editor.id, resource: resource?.toJSON() ?? undefined }],
    [group.id, editor.id, resource],
  )

  return (
    <ContextMenu
      menuId={MenuId.EditorTabContext}
      anchor={{ x, y }}
      args={args}
      commandService={commandService}
      contextKeyService={scopedContext}
      renderIcon={renderMenuIcon}
      autoFocusFirst={keyboard}
      {...(targetDocument ? { targetDocument } : {})}
      {...(memory ? { memory } : {})}
      // Text / diff / settings tabs expose different command sets; bucket the
      // memory per type so a diff tab doesn't restore onto a text-only entry.
      contextTag={editorType}
      onClose={onClose}
    />
  )
}
