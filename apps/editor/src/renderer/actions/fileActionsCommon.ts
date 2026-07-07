/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Private helpers shared across the file*Actions modules. Not re-exported.
 *--------------------------------------------------------------------------------------------*/

import { URI, type UriComponents } from '@universe-editor/platform'
import {
  type ExplorerTreeService,
  type IExplorerResourceOperation,
} from '../services/explorer/ExplorerTreeService.js'
import { sameUri } from '../services/explorer/explorerTreeUtils.js'

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
  tree: ExplorerTreeService,
  args: unknown[],
): IExplorerResourceOperation[] {
  const primary = resolvePrimaryTarget(args)
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
