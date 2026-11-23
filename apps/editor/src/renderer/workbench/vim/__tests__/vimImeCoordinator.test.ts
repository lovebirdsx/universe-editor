/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IME handoff for non-editor Vim surfaces. Runs against the real window-wide
 *  ownership guard (`editor/vim/vimInputMethod.ts`) with a fake main-process service.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '@universe-editor/platform'
import type { VimSurfaceKind, VimSurfaceMode } from '@universe-editor/workbench-ui'
import { VimImeCoordinator, type IVimImeWindowSource } from '../vimImeCoordinator.js'
import type { IVimActiveSurface } from '../../../services/vim/vimModeService.js'
import { requestInputMethod, resetVimInputMethodForTests } from '../../editor/vim/vimInputMethod.js'

/** A workbench window stand-in: just what the coordinator reads from a Document. */
function fakeWindow(focused = true) {
  const target = new EventTarget()
  const state = { focused }
  const doc = { defaultView: target, hasFocus: () => state.focused } as unknown as Document
  return {
    doc,
    blur: () => {
      state.focused = false
      target.dispatchEvent(new Event('blur'))
    },
    focus: () => {
      state.focused = true
      target.dispatchEvent(new Event('focus'))
    },
  }
}

function harness(options: { enabled?: boolean; autoSwitch?: boolean } = {}) {
  const surfaceEmitter = new Emitter<IVimActiveSurface | undefined>()
  const modeEmitter = new Emitter<{ surfaceKey: string; mode: VimSurfaceMode }>()
  const configEmitter = new Emitter<{ affectsConfiguration(key: string): boolean }>()
  const modes = new Map<string, VimSurfaceMode>()
  const state = {
    enabled: options.enabled ?? true,
    autoSwitch: options.autoSwitch ?? true,
    surface: undefined as IVimActiveSurface | undefined,
    disabledKinds: new Set<VimSurfaceKind>(),
  }
  const vim = {
    getEnabled: () => state.enabled,
    getMode: (key: string, fallback: VimSurfaceMode) => modes.get(key) ?? fallback,
    get activeSurface() {
      return state.surface
    },
    isSurfaceEnabled: (kind: VimSurfaceKind) => !state.disabledKinds.has(kind),
    onDidChangeActiveSurface: surfaceEmitter.event,
    onDidChangeMode: modeEmitter.event,
  }
  const inputMethod = {
    _serviceBrand: undefined,
    switchToEnglish: vi.fn(async () => true),
    restore: vi.fn(async () => undefined),
  }
  const config = {
    get: (key: string) => (key === 'vim.autoSwitchInputMethod' ? state.autoSwitch : undefined),
    onDidChangeConfiguration: configEmitter.event,
  }
  const main = fakeWindow()
  const docs: Document[] = [main.doc]
  const addEmitter = new Emitter<Document>()
  const removeEmitter = new Emitter<Document>()
  const windows: IVimImeWindowSource = {
    getDocuments: () => docs,
    onDidAddDocument: addEmitter.event,
    onDidRemoveDocument: removeEmitter.event,
  }
  const addWindow = (win: ReturnType<typeof fakeWindow>) => {
    docs.push(win.doc)
    addEmitter.fire(win.doc)
  }
  const removeWindow = (win: ReturnType<typeof fakeWindow>) => {
    docs.splice(docs.indexOf(win.doc), 1)
    removeEmitter.fire(win.doc)
  }
  const coordinator = new VimImeCoordinator(vim, inputMethod, config as never, windows)
  const activate = (kind: VimSurfaceKind, defaultMode: VimSurfaceMode = 'normal') => {
    state.surface = { surfaceKey: `${kind}:1`, kind, id: `${kind}-1`, defaultMode }
    surfaceEmitter.fire(state.surface)
  }
  const deactivate = () => {
    state.surface = undefined
    surfaceEmitter.fire(undefined)
  }
  const setMode = (key: string, mode: VimSurfaceMode) => {
    modes.set(key, mode)
    modeEmitter.fire({ surfaceKey: key, mode })
  }
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  return {
    coordinator,
    inputMethod,
    activate,
    deactivate,
    setMode,
    state,
    settle,
    configEmitter,
    main,
    addWindow,
    removeWindow,
  }
}

// The ownership guard is module-global; start every test from a clean slate.
afterEach(() => {
  resetVimInputMethodForTests()
})

describe('VimImeCoordinator', () => {
  it('switches to English when a Normal list gains focus and restores on leave', async () => {
    const h = harness()
    h.activate('list')
    await h.settle()
    expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)

    h.deactivate()
    await h.settle()
    expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)
    h.coordinator.dispose()
  })

  it('does not call main again while hopping between Normal surfaces', async () => {
    const h = harness()
    h.activate('list')
    h.activate('tabs')
    h.activate('activityBar')
    await h.settle()
    expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)
    expect(h.inputMethod.restore).not.toHaveBeenCalled()
    h.coordinator.dispose()
  })

  it('does nothing while Vim or vim.autoSwitchInputMethod is off', async () => {
    const off = harness({ enabled: false })
    off.activate('list')
    await off.settle()
    expect(off.inputMethod.switchToEnglish).not.toHaveBeenCalled()
    off.coordinator.dispose()

    const noAuto = harness({ autoSwitch: false })
    noAuto.activate('list')
    await noAuto.settle()
    expect(noAuto.inputMethod.switchToEnglish).not.toHaveBeenCalled()
    noAuto.coordinator.dispose()
  })

  it('leaves a surface kind that is switched off in settings alone', async () => {
    const h = harness()
    h.state.disabledKinds.add('list')
    h.activate('list')
    await h.settle()
    expect(h.inputMethod.switchToEnglish).not.toHaveBeenCalled()
    h.coordinator.dispose()
  })

  it('does not touch the IME for editors or terminals on their own', async () => {
    const h = harness()
    h.activate('editor')
    h.activate('terminal', 'insert')
    await h.settle()
    expect(h.inputMethod.switchToEnglish).not.toHaveBeenCalled()
    expect(h.inputMethod.restore).not.toHaveBeenCalled()
    h.coordinator.dispose()
  })

  it('keeps English when focus moves from a list into an editor in Normal mode', async () => {
    const h = harness()
    h.activate('list')
    h.activate('editor')
    await h.settle()
    expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)
    expect(h.inputMethod.restore).not.toHaveBeenCalled()
    h.coordinator.dispose()
  })

  it('restores when focus moves from a list into an editor in Insert mode', async () => {
    const h = harness()
    h.activate('list')
    h.setMode('editor:1', 'insert')
    h.activate('editor')
    await h.settle()
    expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)
    h.coordinator.dispose()
  })

  it('restores once the surface mode leaves Normal', async () => {
    const h = harness()
    h.activate('list')
    h.setMode('list:1', 'insert')
    await h.settle()
    expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)
    h.coordinator.dispose()
  })

  it('follows vim.autoSwitchInputMethod changes made while a list is focused', async () => {
    const h = harness()
    h.activate('list')
    h.state.autoSwitch = false
    h.configEmitter.fire({ affectsConfiguration: (key) => key === 'vim.autoSwitchInputMethod' })
    await h.settle()
    expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)
    h.coordinator.dispose()
  })

  it('gives English back when vim.enabled is switched off at runtime', async () => {
    const h = harness()
    h.activate('list')
    await h.settle()

    h.state.enabled = false
    h.configEmitter.fire({ affectsConfiguration: (key) => key === 'vim.enabled' })
    await h.settle()
    expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)
    h.coordinator.dispose()
  })

  describe('window focus', () => {
    it('gives English back when the window loses focus and re-asserts it on return', async () => {
      const h = harness()
      h.activate('list')
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)

      h.main.blur()
      await h.settle()
      expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)

      h.main.focus()
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(2)
      h.coordinator.dispose()
    })

    it('does not claim English for a surface activated while the window is unfocused', async () => {
      const h = harness()
      h.main.blur()
      h.activate('list')
      await h.settle()
      expect(h.inputMethod.switchToEnglish).not.toHaveBeenCalled()

      h.main.focus()
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)
      h.coordinator.dispose()
    })

    it('keeps English while any workbench window is focused and drops it when none is', async () => {
      const h = harness()
      const aux = fakeWindow()
      h.addWindow(aux)
      h.activate('list')
      await h.settle()

      h.main.blur()
      await h.settle()
      expect(h.inputMethod.restore).not.toHaveBeenCalled()

      aux.blur()
      await h.settle()
      expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)

      aux.focus()
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(2)
      h.coordinator.dispose()
    })

    it('stops listening to a closed window', async () => {
      const h = harness()
      const aux = fakeWindow()
      h.addWindow(aux)
      h.main.blur()
      h.activate('list')
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)

      h.removeWindow(aux)
      await h.settle()
      // The main window was the only one left and it is blurred.
      expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)

      aux.focus()
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)
      h.coordinator.dispose()
    })
  })

  describe('disposal', () => {
    it('releases what it holds and ignores later events', async () => {
      const h = harness()
      h.activate('list')
      await h.settle()
      h.coordinator.dispose()
      await h.settle()
      expect(h.inputMethod.restore).toHaveBeenCalledTimes(1)

      h.main.focus()
      h.activate('tabs')
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)
    })

    it('does not restore when it never took English', async () => {
      const h = harness()
      h.activate('editor')
      h.coordinator.dispose()
      await h.settle()
      expect(h.inputMethod.restore).not.toHaveBeenCalled()
    })
  })

  describe('races and failures', () => {
    it('queues the restore behind a switchToEnglish that is still in flight', async () => {
      const h = harness()
      const order: string[] = []
      let finishSwitch!: (value: boolean) => void
      h.inputMethod.switchToEnglish.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            order.push('switch:start')
            finishSwitch = (value) => {
              order.push('switch:end')
              resolve(value)
            }
          }),
      )
      h.inputMethod.restore.mockImplementation(async () => {
        order.push('restore')
      })

      h.activate('list')
      h.deactivate()
      await h.settle()
      expect(order).toEqual(['switch:start'])

      finishSwitch(true)
      await h.settle()
      expect(order).toEqual(['switch:start', 'switch:end', 'restore'])
      h.coordinator.dispose()
    })

    it('asks again on the next change after main refused the switch, without restoring', async () => {
      const h = harness()
      h.inputMethod.switchToEnglish.mockResolvedValueOnce(false)
      h.activate('list')
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)

      // The refusal fell back to native, so the next Normal surface asks again.
      h.activate('tabs')
      await h.settle()
      expect(h.inputMethod.switchToEnglish).toHaveBeenCalledTimes(2)
      expect(h.inputMethod.restore).not.toHaveBeenCalled()
      h.coordinator.dispose()
    })

    it('does not hand back English that an editor took over from it', async () => {
      const h = harness()
      h.activate('list')
      await h.settle()

      // A Normal-mode editor claims the window-wide ownership.
      requestInputMethod({}, h.inputMethod, 'english')
      h.activate('editor')
      h.deactivate()
      await h.settle()

      expect(h.inputMethod.restore).not.toHaveBeenCalled()
      h.coordinator.dispose()
      await h.settle()
      expect(h.inputMethod.restore).not.toHaveBeenCalled()
    })
  })
})
