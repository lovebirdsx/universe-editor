/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Symbol breadcrumb picker model. The picker freezes an outline snapshot when
 *  it opens (so a background re-pull cannot reshuffle rows under the pointer)
 *  and reuses the Outline view's tree helpers for ordering and identity.
 *--------------------------------------------------------------------------------------------*/

import type { ITreeDataSource } from '@universe-editor/workbench-ui'
import type { monaco } from '../../editor/monaco/MonacoLoader.js'
import type { OutlineModel } from '../../../services/languageFeatures/editorOutlineTracker.js'
import type { BreadcrumbsSymbolSortOrder } from '../../../services/breadcrumbs/breadcrumbsConfig.js'
import {
  buildOutlineNodes,
  indexOutlineNodes,
  outlineAncestorIds,
  type OutlineNode,
  type OutlineSortOrder,
} from '../../outline/outlineTree.js'

export type SymbolPickerSnapshot = {
  readonly languageId: string
  readonly roots: readonly OutlineNode[]
  readonly nodeById: Map<string, OutlineNode>
  readonly idBySymbol: Map<monaco.languages.DocumentSymbol, string>
  readonly initialId: string | undefined
  readonly ancestorIds: readonly string[]
}

export function toOutlineSortOrder(order: BreadcrumbsSymbolSortOrder): OutlineSortOrder {
  return order === 'type' ? 'kind' : order
}

export function createSymbolPickerSnapshot(
  outline: OutlineModel | undefined,
  activeSymbol: monaco.languages.DocumentSymbol | undefined,
  order: BreadcrumbsSymbolSortOrder,
): SymbolPickerSnapshot {
  const { roots, idBySymbol } = buildOutlineNodes(outline?.roots ?? [], toOutlineSortOrder(order))
  const nodeById = indexOutlineNodes(roots)
  const initialId = (activeSymbol ? idBySymbol.get(activeSymbol) : undefined) ?? roots[0]?.id
  return {
    languageId: outline?.languageId ?? '',
    roots,
    nodeById,
    idBySymbol,
    initialId,
    ancestorIds: initialId === undefined ? [] : outlineAncestorIds(initialId),
  }
}

export function createSymbolPickerDataSource(
  snapshot: SymbolPickerSnapshot,
): ITreeDataSource<OutlineNode> {
  return {
    getId: (node) => node.id,
    hasChildren: (node) => node.children.length > 0,
    getChildren: (node) => node.children,
    getRoots: () => snapshot.roots,
    getParent: (node) => {
      const ancestors = outlineAncestorIds(node.id)
      const parentId = ancestors[ancestors.length - 1]
      return parentId === undefined ? null : (snapshot.nodeById.get(parentId) ?? null)
    },
  }
}
