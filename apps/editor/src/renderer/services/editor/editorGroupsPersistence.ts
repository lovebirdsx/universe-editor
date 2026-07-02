/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  editorGroupsPersistence — serialization types + the tree-walk helper that
 *  flattens a serialized grid into a leaf-order array that EditorGroupsService
 *  can replay via addGroup().
 *--------------------------------------------------------------------------------------------*/

import {
  Direction,
  type ISerializedGrid,
  type ISerializedGridNode,
  Orientation,
} from '@universe-editor/platform'

export interface ISerializedEditorInputData {
  readonly typeId: string
  readonly data: unknown
}

export interface ISerializedEditorGroupData {
  readonly editors: readonly ISerializedEditorInputData[]
  readonly activeIndex: number
  readonly locked?: boolean
  readonly viewStates?: Readonly<Record<string, unknown>>
}

export interface ISerializedEditorGroupsState {
  readonly grid: ISerializedGrid<ISerializedEditorGroupData>
  readonly activeGroupId: number
}

export interface ICollectedLeaf {
  readonly data: ISerializedEditorGroupData
  readonly direction?: Direction
}

export function collectLeavesInOrder(
  node: ISerializedGridNode<unknown>,
  parentOrientation: Orientation | undefined,
  out: ICollectedLeaf[],
  childIndex = 0,
): void {
  if (node.type === 'leaf') {
    const data = node.data as ISerializedEditorGroupData
    if (out.length === 0 || childIndex === 0 || parentOrientation === undefined) {
      out.push({ data })
    } else {
      const dir = parentOrientation === Orientation.Horizontal ? Direction.Right : Direction.Down
      out.push({ data, direction: dir })
    }
    return
  }
  const orient = node.orientation ?? Orientation.Horizontal
  ;(node.children ?? []).forEach((child, i) => {
    collectLeavesInOrder(child, orient, out, i)
  })
}
