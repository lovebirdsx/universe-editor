/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { VimEditor } from '../../../editor/vim/vimTypes.js'
import {
  createOutputVimController,
  type OutputVimControllerOptions,
} from '../outputVimController.js'

function setup(lineCount = 100, options: OutputVimControllerOptions = {}) {
  const lines = Array.from({ length: lineCount }, (_, index) => `  line ${index + 1}`)
  let cursor = { lineNumber: 1, column: 1 }
  const positions: Array<{ lineNumber: number; column: number }> = []
  const reveals: Array<{ lineNumber: number; column: number }> = []
  const trigger = vi.fn()
  const focusListeners = new Set<() => void>()
  const blurListeners = new Set<() => void>()
  let visible = { start: 1, end: 20 }

  const editor = {
    getModel: () => ({
      getLineCount: () => lines.length,
      getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
      getValueInRange: () => '',
      getEOL: () => '\n',
    }),
    getSelections: () => [
      {
        startLineNumber: cursor.lineNumber,
        startColumn: cursor.column,
        endLineNumber: cursor.lineNumber,
        endColumn: cursor.column,
      },
    ],
    setPosition: (position: { lineNumber: number; column: number }) => {
      cursor = { ...position }
      positions.push({ ...position })
    },
    setSelections: () => {},
    executeEdits: () => false,
    pushUndoStop: () => true,
    trigger,
    revealPositionInCenterIfOutsideViewport: (position: { lineNumber: number; column: number }) => {
      reveals.push({ ...position })
    },
    getVisibleRanges: () => [
      { startLineNumber: visible.start, startColumn: 1, endLineNumber: visible.end, endColumn: 1 },
    ],
    getLayoutInfo: () => ({ height: 400, lineHeight: 20 }),
    getContainerDomNode: () => document.createElement('div'),
    onDidFocusEditorText: (listener: () => void) => {
      focusListeners.add(listener)
      return { dispose: () => focusListeners.delete(listener) }
    },
    onDidBlurEditorText: (listener: () => void) => {
      blurListeners.add(listener)
      return { dispose: () => blurListeners.delete(listener) }
    },
    onDidChangeModel: () => ({ dispose: () => {} }),
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    focus: () => {},
    addOverlayWidget: () => {},
    removeOverlayWidget: () => {},
    createDecorationsCollection: () => ({
      set: () => {},
      clear: () => {},
      getRange: () => null,
      length: 0,
    }),
  } as unknown as VimEditor

  const controller = createOutputVimController(editor, options)
  return {
    controller,
    trigger,
    positions,
    reveals,
    setVisible: (start: number, end: number) => {
      visible = { start, end }
    },
    focus: () => {
      for (const listener of focusListeners) listener()
    },
    blur: () => {
      for (const listener of blurListeners) listener()
    },
  }
}

function keyEvent(
  key: string,
  mods: {
    ctrl?: boolean
    alt?: boolean
    meta?: boolean
    shift?: boolean
    keyCode?: number
    isComposing?: boolean
  } = {},
) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    isComposing: mods.isComposing ?? false,
    keyCode: mods.keyCode ?? 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  } as unknown as KeyboardEvent
}

describe('createOutputVimController', () => {
  it('ignores keys until Monaco text focus arrives, then follows blur', () => {
    const h = setup()
    expect(h.controller.handleKeyDown(keyEvent('j'))).toBe(false)

    h.focus()
    expect(h.controller.handleKeyDown(keyEvent('j'))).toBe(true)
    expect(h.positions.at(-1)).toEqual({ lineNumber: 2, column: 3 })

    // A pending count belongs to the focus that typed it.
    h.blur()
    expect(h.controller.handleKeyDown(keyEvent('j'))).toBe(false)
    h.focus()
    expect(h.controller.handleKeyDown(keyEvent('3'))).toBe(true)
    expect(h.controller.handleKeyDown(keyEvent('j'))).toBe(true)
    expect(h.positions.at(-1)).toEqual({ lineNumber: 5, column: 3 })
  })

  it('moves the cursor to the first non-blank column and reveals it', () => {
    const h = setup()
    h.focus()
    h.controller.handleKeyDown(keyEvent('2'))
    h.controller.handleKeyDown(keyEvent('j'))
    expect(h.positions.at(-1)).toEqual({ lineNumber: 3, column: 3 })
    expect(h.reveals.at(-1)).toEqual({ lineNumber: 3, column: 3 })
  })

  it('clamps j/k at the buffer ends', () => {
    const h = setup(10)
    h.focus()
    h.controller.handleKeyDown(keyEvent('k'))
    expect(h.positions.at(-1)).toEqual({ lineNumber: 1, column: 3 })
    h.controller.handleKeyDown(keyEvent('9'))
    h.controller.handleKeyDown(keyEvent('j'))
    expect(h.positions.at(-1)).toEqual({ lineNumber: 10, column: 3 })
  })

  it('moves by display rows with gj/gk through Monaco cursorMove', () => {
    const onViewportScroll = vi.fn()
    const h = setup(100, { onViewportScroll })
    h.focus()
    h.controller.handleKeyDown(keyEvent('g'))
    h.controller.handleKeyDown(keyEvent('j'))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'cursorMove', {
      to: 'down',
      by: 'wrappedLine',
      value: 1,
      select: false,
      noHistory: true,
    })
    h.controller.handleKeyDown(keyEvent('3'))
    h.controller.handleKeyDown(keyEvent('g'))
    h.controller.handleKeyDown(keyEvent('k'))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'cursorMove', {
      to: 'up',
      by: 'wrappedLine',
      value: 3,
      select: false,
      noHistory: true,
    })
    // Only Ctrl+E/Y releases the follow-tail lock; gj/gk keep it.
    expect(onViewportScroll).not.toHaveBeenCalled()
    expect(h.positions).toHaveLength(0)
  })

  it('scrolls the viewport through Monaco editorScroll and releases auto-scroll', () => {
    const onViewportScroll = vi.fn()
    const h = setup(100, { onViewportScroll })
    h.focus()
    h.controller.handleKeyDown(keyEvent('2'))
    h.controller.handleKeyDown(keyEvent('e', { ctrl: true }))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'down',
      by: 'wrappedLine',
      value: 2,
      revealCursor: true,
      select: false,
    })
    expect(onViewportScroll).toHaveBeenCalledTimes(1)
    h.controller.handleKeyDown(keyEvent('y', { ctrl: true }))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'up',
      by: 'wrappedLine',
      value: 1,
      revealCursor: true,
      select: false,
    })
    expect(onViewportScroll).toHaveBeenCalledTimes(2)
  })

  it('scrolls half/full pages through Monaco viewport units', () => {
    const h = setup()
    h.focus()
    h.controller.handleKeyDown(keyEvent('d', { ctrl: true }))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'down',
      by: 'halfPage',
      value: 1,
      revealCursor: true,
      select: false,
    })

    h.controller.handleKeyDown(keyEvent('u', { ctrl: true }))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'up',
      by: 'halfPage',
      value: 1,
      revealCursor: true,
      select: false,
    })

    // `page` / `halfPage` count visual rows, so wrapped log lines cannot shrink
    // the page. Only the `move` command touches the cursor directly.
    h.controller.handleKeyDown(keyEvent('f', { ctrl: true }))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'down',
      by: 'page',
      value: 1,
      revealCursor: true,
      select: false,
    })
    h.controller.handleKeyDown(keyEvent('b', { ctrl: true }))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'up',
      by: 'page',
      value: 1,
      revealCursor: true,
      select: false,
    })
    expect(h.positions).toHaveLength(0)
  })

  it('treats a count as the number of pages', () => {
    const h = setup()
    h.focus()
    h.controller.handleKeyDown(keyEvent('2'))
    h.controller.handleKeyDown(keyEvent('d', { ctrl: true }))
    expect(h.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'down',
      by: 'halfPage',
      value: 2,
      revealCursor: true,
      select: false,
    })
  })

  it('jumps with gg/G, honouring a count as the target line', () => {
    const h = setup()
    h.focus()
    h.controller.handleKeyDown(keyEvent('G'))
    expect(h.positions.at(-1)).toEqual({ lineNumber: 100, column: 3 })

    h.controller.handleKeyDown(keyEvent('g'))
    h.controller.handleKeyDown(keyEvent('g'))
    expect(h.positions.at(-1)).toEqual({ lineNumber: 1, column: 3 })

    h.controller.handleKeyDown(keyEvent('4'))
    h.controller.handleKeyDown(keyEvent('2'))
    h.controller.handleKeyDown(keyEvent('G'))
    expect(h.positions.at(-1)).toEqual({ lineNumber: 42, column: 3 })
  })

  it('lets Escape and function keys through without executing anything', () => {
    const h = setup()
    h.focus()
    expect(h.controller.handleKeyDown(keyEvent('Escape'))).toBe(false)
    expect(h.controller.handleKeyDown(keyEvent('PageDown'))).toBe(false)
    expect(h.positions).toHaveLength(0)
  })

  it('passes through while an IME composition is active', () => {
    const h = setup()
    h.focus()
    expect(h.controller.handleKeyDown(keyEvent('j', { isComposing: true }))).toBe(false)
    expect(h.controller.handleKeyDown(keyEvent('j', { keyCode: 229 }))).toBe(false)
    expect(h.positions).toHaveLength(0)
  })

  it('drops focus subscriptions on dispose', () => {
    const h = setup()
    h.focus()
    h.controller.dispose()
    expect(h.controller.handleKeyDown(keyEvent('j'))).toBe(false)
  })
})
