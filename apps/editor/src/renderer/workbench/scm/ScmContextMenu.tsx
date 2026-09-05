/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmContextMenu — thin wrapper that delegates the SCM row right-click menus
 *  (file / folder / group) to the workbench-ui ContextMenu, mirroring
 *  ExplorerContextMenu. It exists so the SCM list gets the shared menu's
 *  keyboard navigation (arrow keys, Enter, submenu traversal on window capture)
 *  instead of the mouse-only overflow menu it used to render: the ContextMenu
 *  key opened a menu no key could then drive.
 *
 *  Two SCM specifics the shared component takes through props:
 *   - `executeCommand`, because SCM commands carry their own argument shape
 *     (primary + selection / subtree / group descriptor) rather than one `args`
 *     tuple shared by every row kind.
 *   - `renderIcon`, because provider menus (git stage/discard, p4 revert, …)
 *     carry icons; Explorer's menus don't.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, IContextKeyService, type MenuId } from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import { useScopedContextKey } from '../useScopedContextKey.js'
import { useService } from '../useService.js'

export interface ScmContextMenuState {
  readonly anchor: { x: number; y: number }
  readonly menuId: MenuId
  /** Row-scoped context keys (`scmProvider`, `scmResourceGroup`, …) the menu's
   *  `when` clauses are evaluated against. */
  readonly scope: Record<string, unknown>
  /** Runs a picked command with this row kind's own argument shape. */
  readonly run: (command: string) => void
  /** The row menu was raised with the ContextMenu key, so it opens with the
   *  first entry highlighted. */
  readonly keyboard: boolean
}

/** `navigation` items render as inline row buttons, so the menu omits them. */
const withoutNavigation = (group: string): boolean => group !== 'navigation'

function renderIcon(icon: string | undefined) {
  const Icon = resolveHeaderIcon(icon)
  return Icon ? <Icon size={16} strokeWidth={1.6} /> : null
}

export function ScmContextMenu({
  state,
  onClose,
}: {
  readonly state: ScmContextMenuState
  readonly onClose: () => void
}) {
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const { anchor, menuId, scope, run, keyboard } = state

  const scopedContext = useScopedContextKey(contextKeyService, scope)

  return (
    <ContextMenu
      menuId={menuId}
      anchor={anchor}
      commandService={commandService}
      contextKeyService={scopedContext}
      executeCommand={run}
      groupFilter={withoutNavigation}
      renderIcon={renderIcon}
      autoFocusFirst={keyboard}
      onClose={onClose}
    />
  )
}
