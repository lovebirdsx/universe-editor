/*---------------------------------------------------------------------------------------------
 *  domRealm — workbench-ui 与编辑器 renderer 共用的形状判定。辅助窗口是独立
 *  realm 的同源 popup，其元素对主 realm 的 `instanceof HTMLElement` 为 false，
 *  因此“是不是元素/可编辑”必须按形状判断。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isEditableElement, isElementLike, isHTMLElementLike } from '../dom/domRealm.js'

/** 只带形状的异 realm 元素替身（真实场景由辅助窗口 e2e 守护）。 */
const foreign = (tagName: string, isContentEditable = false) => ({
  nodeType: 1,
  tagName,
  isContentEditable,
})

describe('domRealm', () => {
  it('classifies foreign-realm elements by shape', () => {
    expect(isElementLike(foreign('DIV'))).toBe(true)
    expect(isHTMLElementLike(foreign('DIV'))).toBe(true)
    expect(isEditableElement(foreign('INPUT'))).toBe(true)
    expect(isEditableElement(foreign('TEXTAREA'))).toBe(true)
    expect(isEditableElement(foreign('SELECT'))).toBe(true)
    expect(isEditableElement(foreign('DIV', true))).toBe(true)
    expect(isEditableElement(foreign('BUTTON'))).toBe(false)
  })

  it('classifies main-realm elements the same way', () => {
    const div = document.createElement('div')
    const input = document.createElement('input')
    expect(isElementLike(div)).toBe(true)
    expect(isHTMLElementLike(div)).toBe(true)
    expect(isEditableElement(input)).toBe(true)
    expect(isEditableElement(div)).toBe(false)
  })

  it('rejects non-elements', () => {
    expect(isElementLike(null)).toBe(false)
    expect(isElementLike(undefined)).toBe(false)
    expect(isElementLike(document)).toBe(false)
    expect(isElementLike({})).toBe(false)
    expect(isHTMLElementLike({ nodeType: 3, tagName: 'X' })).toBe(false)
  })
})
