/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Private helpers shared across the file*Actions modules. Not re-exported.
 *--------------------------------------------------------------------------------------------*/

import {
  IContextKeyService,
  IEditorGroupsService,
  URI,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import {
  type ExplorerTreeService,
  type IExplorerResourceOperation,
} from '../services/explorer/ExplorerTreeService.js'
import { sameUri } from '../services/explorer/explorerTreeUtils.js'

const EXPLORER_TREE_VIEW_ID = 'workbench.view.explorer.tree'

/**
 * When-clause gating Explorer file-command keybindings to the moment the
 * Explorer tree owns keyboard focus (and no text editor / terminal does). Keeps
 * a global stroke like F2 from stealing the keystroke away from Monaco's own
 * binding (e.g. `editor.action.rename`) when the cursor is in a code editor.
 */
export const EXPLORER_FOCUS_WHEN = `focusedView == '${EXPLORER_TREE_VIEW_ID}' && !editorTextFocus && !terminalFocus`

export function reviveUri(value: URI | UriComponents | null): URI | null {
  if (!value) return null
  return value instanceof URI ? value : (URI.revive(value) as URI)
}

export interface ITargetArg {
  readonly target?: URI | UriComponents
  readonly resource?: URI | UriComponents
  readonly parent?: URI | UriComponents
  readonly isDirectory?: boolean
}

export function resolvePrimaryTarget(args: unknown[]): URI | null {
  const arg = args[0] as ITargetArg | undefined
  return reviveUri(arg?.target ?? arg?.resource ?? null)
}

/** True when the Explorer tree currently owns keyboard focus. */
export function isExplorerTreeFocused(accessor: ServicesAccessor): boolean {
  return accessor.get(IContextKeyService).get('focusedView') === EXPLORER_TREE_VIEW_ID
}

/** The active editor's file resource, or null when it is not a file editor. */
export function activeEditorFileResource(accessor: ServicesAccessor): URI | null {
  const active = accessor.get(IEditorGroupsService).activeGroup.activeEditor
  return active instanceof FileEditorInput ? active.resource : null
}

/**
 * The implicit primary target when no explicit one is passed. When the Explorer
 * tree does not own focus (e.g. command palette), prefer the active editor's
 * file so the command targets what the user is looking at rather than a drifted
 * Explorer selection (relevant when `explorer.autoReveal` is off). Returns null
 * to defer to the Explorer selection.
 */
export function implicitPrimaryTarget(accessor: ServicesAccessor): URI | null {
  if (isExplorerTreeFocused(accessor)) return null
  return activeEditorFileResource(accessor)
}

/**
 * The resource an Explorer file command should act on when invoked without an
 * explicit target. Mirrors VSCode's `getResourceForCommand`: when the Explorer
 * tree owns focus, act on its selection; otherwise (command palette / editor
 * focus) prefer the active editor's file, falling back to the Explorer
 * selection when no file editor is active. This keeps commands like Delete /
 * Rename targeting the file the user is looking at even when
 * `explorer.autoReveal` is off and the tree selection has drifted.
 */
export function implicitCommandResource(
  accessor: ServicesAccessor,
  tree: ExplorerTreeService,
): URI | null {
  if (isExplorerTreeFocused(accessor)) return tree.selectedResource
  return activeEditorFileResource(accessor) ?? tree.selectedResource
}

/**
 * Resolve the entries an Explorer command should act on, honoring multi-select.
 *
 * When the invoking row (context menu / keyboard `primary`) is part of the
 * current selection, the whole selection is returned; otherwise the command
 * acts on that single row (or, without an explicit target, the focused row).
 * The workspace root is never included. Shared by cut/copy/move/delete so they
 * all behave consistently on multiple selected items.
 */
export function resolveContextOperations(
  accessor: ServicesAccessor,
  tree: ExplorerTreeService,
  args: unknown[],
): IExplorerResourceOperation[] {
  const primary = resolvePrimaryTarget(args) ?? implicitPrimaryTarget(accessor)
  const arg = args[0] as ITargetArg | undefined
  const operations = tree.getContextResourceOperations(primary)
  return operations
    .map((operation) => {
      if (primary && sameUri(operation.resource, primary) && arg?.isDirectory !== undefined) {
        return { resource: operation.resource, isDirectory: arg.isDirectory }
      }
      return operation
    })
    .filter((operation) => !tree.isRoot(operation.resource))
}
