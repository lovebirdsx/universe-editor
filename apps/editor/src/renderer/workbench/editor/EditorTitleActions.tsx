/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renders the `MenuId.EditorTitle` action row for an editor group, driven by a
 *  per-group scoped ContextKeyService so each group shows the actions that match
 *  its own active editor. Reuses the shared ViewTitleActions button row.
 *--------------------------------------------------------------------------------------------*/

import { MenuId, type IEditorGroup } from '@universe-editor/platform'
import { ViewTitleActions } from '../viewContainerHeader/ViewTitleActions.js'
import { useEditorGroupScopedContextKey } from './useEditorGroupScopedContextKey.js'

export function EditorTitleActions({ group }: { group: IEditorGroup }) {
  const ctx = useEditorGroupScopedContextKey(group)
  return <ViewTitleActions menuId={MenuId.EditorTitle} contextKeyService={ctx} group="navigation" />
}
