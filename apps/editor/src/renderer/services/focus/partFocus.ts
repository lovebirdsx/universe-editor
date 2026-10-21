/*---------------------------------------------------------------------------------------------
 *  partFocus — “这个 Part 现在是否聚焦在用户所在的那个窗口”。
 *
 *  `Part.isFocused()` 读自己的 document，对单个窗口是准确的；但后台窗口会保留
 *  最后的 activeElement，另一个文档里的 Part 仍可能报告聚焦。toggle 类命令
 *  （Ctrl+Shift+E 等）不能把它当成“焦点已经在这里”，否则会收起侧栏而不是显示。
 *--------------------------------------------------------------------------------------------*/

import type { ILayoutService, IPart, PartId } from '@universe-editor/platform'
import { getActiveWorkbenchDocument } from '../windows/workbenchDocuments.js'

export function getPartDocument(part: IPart): Document | undefined {
  // 单测替身没有挂载容器；没有容器与未挂载的 Part 同义。
  return part.getContainer?.()?.ownerDocument as Document | undefined
}

export function isPartFocusedInActiveDocument(layout: ILayoutService, id: PartId): boolean {
  const part = layout.getPart(id)
  if (!part?.isFocused()) return false
  const doc = getPartDocument(part)
  // 没有容器文档的 Part（替身/已分离）无法证明属于别的窗口，保留普通聚焦答案。
  return doc === undefined || doc === getActiveWorkbenchDocument()
}
