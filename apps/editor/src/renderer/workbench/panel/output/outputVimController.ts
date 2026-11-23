/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Binds the read-only Output editor to the reduced Vim keymap. Unlike the file
 *  editor's controller this owns no mode, no context keys and no IME switching:
 *  it only moves the cursor / scrolls the viewport when Monaco's text focus is
 *  inside the output widget.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '@universe-editor/platform'
import {
  consumeEvent,
  isImeKeyEvent,
  pageScrollPayload,
  scrollViewportPayload,
  toVimKeyInput,
} from '../../editor/vim/vimKeyUtils.js'
import { idle } from '../../editor/vim/vimKeymap.js'
import { firstNonBlankColumn } from '../../editor/vim/vimMotions.js'
import type { VimEditor } from '../../editor/vim/vimTypes.js'
import {
  INITIAL_OUTPUT_VIM_STATE,
  reduceOutputVimKey,
  type OutputVimCommand,
  type OutputVimState,
} from './outputVimKeymap.js'

export interface IOutputVimController extends IDisposable {
  /** Whether Monaco's text input currently holds focus. */
  hasTextFocus(): boolean
  /** Route one keydown; returns true when Vim consumed it. */
  handleKeyDown(event: KeyboardEvent): boolean
}

export interface OutputVimControllerOptions {
  /**
   * A cursor-less viewport scroll means the reader left the tail; the view uses
   * this to release its follow-tail lock before the next append arrives.
   */
  readonly onViewportScroll?: () => void
}

export function createOutputVimController(
  editor: VimEditor,
  options: OutputVimControllerOptions = {},
): IOutputVimController {
  let state: OutputVimState = INITIAL_OUTPUT_VIM_STATE
  let textFocused = false

  function currentLine(): number {
    return editor.getSelections()?.[0]?.startLineNumber ?? 1
  }

  function moveCursorTo(line: number): void {
    const model = editor.getModel()
    if (model === null) return
    const lineNumber = Math.max(1, Math.min(model.getLineCount(), line))
    const position = {
      lineNumber,
      column: firstNonBlankColumn(model.getLineContent(lineNumber)),
    }
    editor.setPosition(position, 'vim')
    editor.revealPositionInCenterIfOutsideViewport(position)
  }

  function execute(command: OutputVimCommand): void {
    switch (command.type) {
      case 'move': {
        const delta = command.direction === 'down' ? command.count : -command.count
        moveCursorTo(currentLine() + delta)
        return
      }
      case 'scroll-viewport':
        options.onViewportScroll?.()
        editor.trigger(
          'vim',
          'editorScroll',
          scrollViewportPayload(command.direction, command.count),
        )
        return
      case 'page':
        // `halfPage` / `page` are Monaco's viewport-relative units: they count
        // visual rows, so a wrapped log line cannot shrink the page. The
        // explicit cursor reveal keeps Vim's "move by a screen" behavior and
        // lets the normal cursor listener update the follow-tail lock.
        editor.trigger(
          'vim',
          'editorScroll',
          pageScrollPayload(command.direction, command.fraction, command.count),
        )
        return
      case 'goto': {
        if (command.line !== null) {
          moveCursorTo(command.line)
          return
        }
        const model = editor.getModel()
        if (model === null) return
        moveCursorTo(command.target === 'first' ? 1 : model.getLineCount())
        return
      }
    }
  }

  const focusSubscription = editor.onDidFocusEditorText(() => {
    textFocused = true
  })
  const blurSubscription = editor.onDidBlurEditorText(() => {
    textFocused = false
    state = idle(state)
  })

  return {
    hasTextFocus: () => textFocused,
    handleKeyDown(event) {
      if (!textFocused) return false
      if (isImeKeyEvent(event)) return false
      const result = reduceOutputVimKey(state, toVimKeyInput(event))
      state = result.state
      if (!result.handled) return false
      consumeEvent(event)
      if (result.command !== null) execute(result.command)
      return true
    },
    dispose() {
      textFocused = false
      state = INITIAL_OUTPUT_VIM_STATE
      focusSubscription.dispose()
      blurSubscription.dispose()
    },
  }
}
