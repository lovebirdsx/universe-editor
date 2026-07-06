/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renders the `MenuId.EditorTitle` action area for an editor group: the primary
 *  `navigation` group as inline icon buttons (via ViewTitleActions) plus a `…`
 *  overflow button that pops the remaining groups (close, lock, …) in a
 *  ContextMenu — mirroring VSCode's editor title toolbar primary/secondary split.
 *  Everything resolves against a per-group scoped ContextKeyService so each group
 *  shows the actions that match its own active editor.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import {
  ICommandService,
  MenuId,
  MenuRegistry,
  combinedDisposable,
  isSubmenuEntry,
  localize,
  markAsSingleton,
  type IContextKeyService,
  type IEditorGroup,
} from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import { MoreHorizontal } from 'lucide-react'
import { useService } from '../useService.js'
import { ViewTitleActions } from '../viewContainerHeader/ViewTitleActions.js'
import { useEditorGroupScopedContextKey } from './useEditorGroupScopedContextKey.js'
import styles from '../viewContainerHeader/ViewTitleActions.module.css'

const NAVIGATION_GROUP = 'navigation'

/** True when EditorTitle has at least one visible non-navigation entry for this scope. */
function useHasOverflow(ctx: IContextKeyService): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const d = markAsSingleton(
        combinedDisposable(
          MenuRegistry.onDidChangeMenu((changed) => {
            if (changed === MenuId.EditorTitle) onChange()
          }),
          ctx.onDidChangeContext(() => onChange()),
        ),
      )
      return () => d.dispose()
    },
    [ctx],
  )
  const getSnapshot = useCallback(() => {
    const items = MenuRegistry.getMenuItems(MenuId.EditorTitle, ctx)
    return items.some((it) => !isSubmenuEntry(it) && (it.group ?? '') !== NAVIGATION_GROUP)
  }, [ctx])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function EditorTitleActions({ group }: { group: IEditorGroup }) {
  const ctx = useEditorGroupScopedContextKey(group)
  const commandService = useService(ICommandService)
  const hasOverflow = useHasOverflow(ctx)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const label = localize('editorTitle.moreActions', 'More Actions…')

  return (
    <>
      <ViewTitleActions
        menuId={MenuId.EditorTitle}
        contextKeyService={ctx}
        group={NAVIGATION_GROUP}
        actionArg={{ groupId: group.id }}
      />
      {hasOverflow && (
        <button
          ref={btnRef}
          className={styles['actionBtn']}
          onClick={() => {
            const rect = btnRef.current?.getBoundingClientRect()
            if (rect) setMenu({ x: rect.left, y: rect.bottom })
          }}
          title={label}
          aria-label={label}
          data-testid="editor-title-overflow"
        >
          <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
      {menu && (
        <ContextMenu
          menuId={MenuId.EditorTitle}
          anchor={menu}
          args={[{ groupId: group.id }]}
          commandService={commandService}
          contextKeyService={ctx}
          groupFilter={(g) => g !== NAVIGATION_GROUP}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}
