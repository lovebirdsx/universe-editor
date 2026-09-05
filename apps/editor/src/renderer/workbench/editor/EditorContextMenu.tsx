/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorContextMenu — the code editor right-click menu. Thin wrapper around the
 *  workbench-ui ContextMenu; items come from MenuRegistry (EditorContextMenuContribution
 *  registers built-ins at BlockStartup, extensions contribute via `contributes.menus['editor/context']`).
 *
 *  Seeds a scoped ContextKeyService from the *clicked* editor (selection, language,
 *  resource scheme/extname, read-only) so `when`-clauses gate against the editor
 *  under the cursor rather than the globally-active one. The first command arg is
 *  the clicked document URI (VSCode's editor/context contract); it is serialized
 *  to UriComponents across the extension-host RPC and revived on the other side.
 *--------------------------------------------------------------------------------------------*/

import {
  MenuId,
  type ICommandService,
  type IContextKeyService,
  type URI,
} from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import type { monaco } from './monaco/MonacoLoader.js'
import { basenameOfResource, extensionOfBasename } from '../files/resourceInfo.js'
import { useScopedContextKey } from '../useScopedContextKey.js'

interface Props {
  readonly x: number
  readonly y: number
  readonly resource: URI
  readonly editor: monaco.editor.IStandaloneCodeEditor
  readonly isReadonly: boolean
  readonly commandService: ICommandService
  readonly contextKeyService: IContextKeyService
  readonly onClose: () => void
}

export function EditorContextMenu({
  x,
  y,
  resource,
  editor,
  isReadonly,
  commandService,
  contextKeyService,
  onClose,
}: Props) {
  const resourceScheme = resource.scheme
  const resourceExtname = extensionOfBasename(basenameOfResource(resource)) ?? ''
  const selection = editor.getSelection()

  const scopedContext = useScopedContextKey(contextKeyService, {
    resourceScheme,
    resourceExtname,
    editorHasSelection: selection !== null && !selection.isEmpty(),
    editorLangId: editor.getModel()?.getLanguageId() ?? '',
    editorReadonly: isReadonly,
  })

  return (
    <ContextMenu
      menuId={MenuId.EditorContext}
      anchor={{ x, y }}
      args={[resource]}
      commandService={commandService}
      contextKeyService={scopedContext}
      onClose={onClose}
    />
  )
}
