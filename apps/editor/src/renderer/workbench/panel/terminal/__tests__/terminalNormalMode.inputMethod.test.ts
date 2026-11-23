/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The terminal's use of the window-wide input-method ownership guard, against the
 *  real guard (the mocked unit tests live in terminalNormalMode.test.ts). The bug
 *  these pin: the terminal used to keep a private "I switched" flag, so after focus
 *  moved to another English owner it still restored Chinese under it, and a return
 *  to the terminal never switched back to English.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VimSurfaceMode } from '@universe-editor/workbench-ui'
import {
  requestInputMethod,
  resetVimInputMethodForTests,
} from '../../../editor/vim/vimInputMethod.js'
import {
  TerminalNormalModeController,
  type TerminalNormalModeTarget,
} from '../terminalNormalMode.js'

afterEach(() => {
  resetVimInputMethodForTests()
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function makeTerminal(): TerminalNormalModeTarget {
  return {
    rows: 10,
    buffer: { active: { cursorY: 0, viewportY: 0, baseY: 0, length: 10 } },
    scrollLines() {},
    scrollToLine() {},
    selectLines() {},
    getSelection: () => '',
    hasSelection: () => false,
    clearSelection() {},
    focus() {},
  }
}

function setup() {
  const modes = new Map<string, VimSurfaceMode>()
  const vim = {
    getEnabled: () => true,
    isSurfaceEnabled: () => true,
    getMode: (key: string, fallback: VimSurfaceMode) => modes.get(key) ?? fallback,
    setMode: (key: string, mode: VimSurfaceMode) => {
      modes.set(key, mode)
    },
  }
  const inputMethod = {
    _serviceBrand: undefined,
    switchToEnglish: vi.fn(async () => true),
    restore: vi.fn(async () => undefined),
  }
  const make = (surfaceKey = 'terminal:t1') =>
    new TerminalNormalModeController({
      surfaceKey,
      target: makeTerminal(),
      vimModeService: vim,
      inputMethodService: inputMethod,
      copySelection: async () => {},
    })
  return { make, inputMethod }
}

describe('TerminalNormalModeController input method (real ownership guard)', () => {
  it('does not restore Chinese under another owner that took English after focus moved', async () => {
    const { make, inputMethod } = setup()
    const terminal = make()
    terminal.enterNormalMode()
    await settle()
    expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)

    // Focus moves into a Normal-mode editor, which takes the ownership first.
    requestInputMethod({}, inputMethod, 'english')
    terminal.handleFocusOut()
    await settle()

    expect(inputMethod.restore).not.toHaveBeenCalled()
  })

  it('switches back to English when focus returns to a terminal that is still in Normal mode', async () => {
    const { make, inputMethod } = setup()
    const terminal = make()
    terminal.enterNormalMode()
    terminal.handleFocusOut()
    await settle()
    expect(inputMethod.restore).toHaveBeenCalledTimes(1)

    terminal.handleFocusIn()
    await settle()
    expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(2)
  })

  it('leaves another owner’s English alone when a Normal terminal is detached', async () => {
    const { make, inputMethod } = setup()
    const background = make('terminal:bg')
    background.enterNormalMode()
    await settle()
    // Another surface now holds English; the background terminal going away is silent.
    requestInputMethod({}, inputMethod, 'english')

    background.dispose()
    await settle()

    expect(inputMethod.restore).not.toHaveBeenCalled()
  })

  it('restores once when the holding terminal is detached on reparent', async () => {
    const { make, inputMethod } = setup()
    const terminal = make()
    terminal.enterNormalMode()
    await settle()

    terminal.dispose()
    await settle()

    expect(inputMethod.restore).toHaveBeenCalledTimes(1)
  })
})
