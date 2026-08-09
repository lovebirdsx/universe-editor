/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  processTreeModel — pure tree-flattening logic for the Process Explorer.
 *  Kept free of React so it can be unit-tested in a plain node environment.
 *--------------------------------------------------------------------------------------------*/

import type { IProcessItem } from '../../../shared/ipc/processMonitorService.js'

export interface FlatRow {
  readonly item: IProcessItem
  readonly depth: number
  readonly hasChildren: boolean
}

export function flattenProcessTree(root: IProcessItem, collapsed: ReadonlySet<number>): FlatRow[] {
  const rows: FlatRow[] = []
  const walk = (item: IProcessItem, depth: number): void => {
    const children = item.children ?? []
    rows.push({ item, depth, hasChildren: children.length > 0 })
    if (collapsed.has(item.pid)) return
    for (const child of children) {
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}
