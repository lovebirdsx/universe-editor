/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  A terminal moving between the panel and the editor area unmounts one
 *  TerminalInstance and mounts another on the same xterm holder. The remembered
 *  Normal mode must survive that, the input method must be handed back on the
 *  way out, and the new instance must pick it up again when focus is there.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Emitter, IConfigurationService } from '@universe-editor/platform'
import type { VimSurfaceMode } from '@universe-editor/workbench-ui'
import { __resetVimSurfacesForTests } from '@universe-editor/workbench-ui'
import { IVimInputMethodService } from '../../../../../shared/ipc/vimInputMethodService.js'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import { ITerminalXtermService } from '../../../../services/terminal/TerminalXtermService.js'
import { IVimModeService } from '../../../../services/vim/vimModeService.js'
import { releaseInputMethod, requestInputMethod } from '../../../editor/vim/vimInputMethod.js'
import { ServicesContext } from '../../../useService.js'
import { TerminalInstance } from '../TerminalInstance.js'

vi.mock('../../../editor/vim/vimInputMethod.js', () => ({
  requestInputMethod: vi.fn(),
  releaseInputMethod: vi.fn(),
}))

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function setup() {
  const textarea = document.createElement('textarea')
  const wrapper = document.createElement('div')
  wrapper.appendChild(textarea)
  const holder = {
    term: {},
    wrapper,
    onDidChangeSelection: new Emitter<void>().event,
    setLinkHandlers() {},
    reattachTo(host: HTMLElement) {
      host.appendChild(wrapper)
    },
    fit() {},
    scheduleFit() {},
    saveScroll() {},
    restoreScroll() {},
    focus() {
      textarea.focus()
    },
    hasSelection: () => false,
  }

  const modes = new Map<string, VimSurfaceMode>([['terminal:t1', 'terminal-normal']])
  const modeEmitter = new Emitter<{ surfaceKey: string; mode: VimSurfaceMode }>()
  const state = { enabled: true }
  const vim = {
    _serviceBrand: undefined,
    onDidChangeMode: modeEmitter.event,
    getEnabled: () => state.enabled,
    isSurfaceEnabled: () => true,
    getMode: (key: string, fallback: VimSurfaceMode) => modes.get(key) ?? fallback,
    setMode: vi.fn((key: string, mode: VimSurfaceMode) => {
      modes.set(key, mode)
    }),
    forgetSurface: vi.fn((key: string) => {
      modes.delete(key)
    }),
  }
  const removeEmitter = new Emitter<{ id: string }>()
  const manager = {
    _serviceBrand: undefined,
    onFocusRequest: new Emitter<void>().event,
    onFocusRequestById: new Emitter<string>().event,
    onDidRemoveTerminal: removeEmitter.event,
  }
  const inputMethod = {
    _serviceBrand: undefined,
    switchToEnglish: vi.fn(async () => true),
    restore: vi.fn(async () => undefined),
  }
  const config = {
    _serviceBrand: undefined,
    get: () => undefined,
    onDidChangeConfiguration: new Emitter<never>().event,
  }

  const map = new Map<unknown, unknown>([
    [ITerminalManagerService, manager],
    [ITerminalXtermService, { _serviceBrand: undefined, acquire: () => holder }],
    [IVimModeService, vim],
    [IVimInputMethodService, inputMethod],
    [IConfigurationService, config],
  ])
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => map.get(id) }),
  }
  const mount = () =>
    render(
      <ServicesContext.Provider value={container as never}>
        <TerminalInstance
          id="t1"
          active
          focused={false}
          cwd="/tmp"
          home={undefined}
          resolveFile={async () => null}
          openFile={() => {}}
        />
      </ServicesContext.Provider>,
    )
  return { mount, modes, vim, inputMethod, textarea, removeEmitter }
}

describe('TerminalInstance Normal mode across reparent', () => {
  const originalRO = globalThis.ResizeObserver

  beforeEach(() => {
    globalThis.ResizeObserver = FakeResizeObserver as never
    vi.mocked(requestInputMethod).mockClear()
    vi.mocked(releaseInputMethod).mockClear()
  })

  afterEach(() => {
    cleanup()
    __resetVimSurfacesForTests()
    globalThis.ResizeObserver = originalRO
  })

  it('keeps Normal mode on unmount but gives the input method back', async () => {
    const { mount, modes, vim, inputMethod } = setup()
    const view = mount()

    await act(async () => view.unmount())

    expect(modes.get('terminal:t1')).toBe('terminal-normal')
    expect(vim.setMode).not.toHaveBeenCalled()
    expect(releaseInputMethod).toHaveBeenCalledWith(expect.any(Object), inputMethod)
  })

  it('claims English when focus reaches the remounted terminal and drops it on blur', async () => {
    const { mount, textarea, inputMethod } = setup()
    const first = mount()
    await act(async () => first.unmount())
    vi.mocked(requestInputMethod).mockClear()

    mount()
    expect(requestInputMethod).not.toHaveBeenCalled()

    await act(async () => textarea.focus())
    expect(requestInputMethod).toHaveBeenLastCalledWith(expect.any(Object), inputMethod, 'english')

    await act(async () => textarea.blur())
    expect(releaseInputMethod).toHaveBeenLastCalledWith(expect.any(Object), inputMethod)
  })

  it('hands English back when the window loses focus while the terminal is focused', async () => {
    const { mount, textarea, inputMethod } = setup()
    mount()
    await act(async () => textarea.focus())
    vi.mocked(releaseInputMethod).mockClear()

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(releaseInputMethod).toHaveBeenLastCalledWith(expect.any(Object), inputMethod)

    vi.mocked(requestInputMethod).mockClear()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(requestInputMethod).toHaveBeenLastCalledWith(expect.any(Object), inputMethod, 'english')
  })

  it('forgets the remembered mode only when the terminal itself is removed', async () => {
    const { mount, modes, removeEmitter } = setup()
    mount()

    removeEmitter.fire({ id: 't1' })

    expect(modes.has('terminal:t1')).toBe(false)
  })
})
