/*---------------------------------------------------------------------------------------------
 *  domRealm — 不依赖 realm 的 DOM 形状判定。
 *
 *  辅助窗口是同源 `about:blank` popup，有独立的 JS realm 与 document；对它里面的
 *  元素做主 realm 的 `instanceof HTMLElement` 恒为 false，曾导致可编辑输入框、
 *  对话框按钮和浮层内容都认不出来。凡是可能遇到辅助窗口元素的路径都不要再用
 *  `instanceof`，改判与平台无关的形状。
 *--------------------------------------------------------------------------------------------*/

/** `nodeType === 1` + tagName，SVG/XML 元素也匹配。 */
export function isElementLike(value: unknown): value is Element {
  if (typeof value !== 'object' || value === null) return false
  const node = value as { nodeType?: unknown; tagName?: unknown }
  return node.nodeType === 1 && typeof node.tagName === 'string'
}

/** 与调用点一致的 HTML 风味形状判定。 */
export function isHTMLElementLike(value: unknown): value is HTMLElement {
  return isElementLike(value)
}

/** 原生文本输入控件或 contenteditable 区域。 */
export function isEditableElement(value: unknown): boolean {
  if (!isElementLike(value)) return false
  const tag = value.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (value as HTMLElement).isContentEditable === true
}
