/*---------------------------------------------------------------------------------------------
 *  Unit tests for the keyboard context-menu plumbing used by FileEditor.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { monaco } from '../MonacoLoader.js'
import {
  computeEditorContextMenuAnchor,
  isEditorContextMenuKey,
  type ContextMenuAnchorEditor,
} from '../editorContextMenuKeyboard.js'

const IMMEDIATE = 1 as monaco.editor.ScrollType

const NO_MODIFIERS = {
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
}

function makeEditor(
  order: string[],
  overrides: Partial<ContextMenuAnchorEditor> = {},
): ContextMenuAnchorEditor {
  return {
    getPosition: () => ({ lineNumber: 3, column: 5 }),
    revealPosition: () => order.push('reveal'),
    render: () => order.push('render'),
    getScrolledVisiblePosition: () => {
      order.push('caret')
      return { top: 40, left: 62, height: 18 }
    },
    getDomNode: () => ({ getBoundingClientRect: () => ({ left: 100, top: 200 }) }),
    ...overrides,
  }
}

describe('editorContextMenuKeyboard', () => {
  it('reveals and renders before reading the caret, then maps to viewport coordinates', () => {
    const order: string[] = []
    expect(computeEditorContextMenuAnchor(makeEditor(order), IMMEDIATE)).toEqual({
      x: 162,
      y: 258,
    })
    expect(order).toEqual(['reveal', 'render', 'caret'])
  })

  it('returns null without a cursor or a dom node', () => {
    expect(
      computeEditorContextMenuAnchor(makeEditor([], { getPosition: () => null }), IMMEDIATE),
    ).toBeNull()
    expect(
      computeEditorContextMenuAnchor(makeEditor([], { getDomNode: () => null }), IMMEDIATE),
    ).toBeNull()
  })

  it('falls back to the editor corner when caret coordinates are unavailable', () => {
    expect(
      computeEditorContextMenuAnchor(
        makeEditor([], { getScrolledVisiblePosition: () => null }),
        IMMEDIATE,
      ),
    ).toEqual({ x: 108, y: 208 })
  })

  it('accepts exactly the ContextMenu key and bare Shift+F10', () => {
    expect(isEditorContextMenuKey({ key: 'ContextMenu', ...NO_MODIFIERS })).toBe(true)
    expect(isEditorContextMenuKey({ key: 'F10', ...NO_MODIFIERS, shiftKey: true })).toBe(true)
    expect(isEditorContextMenuKey({ key: 'F10', ...NO_MODIFIERS })).toBe(false)
    expect(
      isEditorContextMenuKey({ key: 'F10', ...NO_MODIFIERS, shiftKey: true, ctrlKey: true }),
    ).toBe(false)
    expect(
      isEditorContextMenuKey({ key: 'F10', ...NO_MODIFIERS, shiftKey: true, altKey: true }),
    ).toBe(false)
    expect(
      isEditorContextMenuKey({ key: 'F10', ...NO_MODIFIERS, shiftKey: true, metaKey: true }),
    ).toBe(false)
    expect(isEditorContextMenuKey({ key: 'Enter', ...NO_MODIFIERS })).toBe(false)
  })
})
