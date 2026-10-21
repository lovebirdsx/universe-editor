/*---------------------------------------------------------------------------------------------
 *  domUtils — DOM 判定必须适用于另一个 workbench document 的元素（辅助窗口有
 *  独立 realm，主 realm 的 `instanceof HTMLElement` 对它为 false）。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isEditableTarget } from '../domUtils.js'

/** 只带形状的异 realm 元素替身（真实场景由 e2e 守护）。 */
function foreignElement(tagName: string, isContentEditable = false): EventTarget {
  return {
    nodeType: 1,
    tagName,
    isContentEditable,
  } as unknown as EventTarget
}

describe('isEditableTarget', () => {
  it('recognizes foreign-realm text-entry elements by shape', () => {
    expect(isEditableTarget(foreignElement('INPUT'))).toBe(true)
    expect(isEditableTarget(foreignElement('TEXTAREA'))).toBe(true)
    expect(isEditableTarget(foreignElement('SELECT'))).toBe(true)
    expect(isEditableTarget(foreignElement('DIV', true))).toBe(true)
  })

  it('rejects a foreign-realm non-editable element', () => {
    expect(isEditableTarget(foreignElement('BUTTON'))).toBe(false)
  })

  it('still recognizes main-realm editables and rejects buttons', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(isEditableTarget(input)).toBe(true)
    const button = document.createElement('button')
    document.body.appendChild(button)
    expect(isEditableTarget(button)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
