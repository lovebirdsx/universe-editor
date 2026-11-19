/*---------------------------------------------------------------------------------------------
 *  Two workbench documents (main + auxiliary window) each install a dispatcher.
 *  Only the focused document may publish the active surface, otherwise a stale
 *  focusout refresh from one window overwrites the other's context keys.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { cleanup, render } from '@testing-library/react'
import {
  ContextKeyService,
  Event,
  ICommandService,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { __resetVimSurfacesForTests, registerVimSurface } from '@universe-editor/workbench-ui'
import { ServicesContext } from '../../useService.js'
import { IKeyboardDebugService } from '../../../services/keybinding/keyboardDebugService.js'
import { IVimModeService } from '../../../services/vim/vimModeService.js'
import {
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
} from '../../../services/windows/workbenchDocuments.js'
import { useVimDispatcher } from '../useVimDispatcher.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanup()
  __resetVimSurfacesForTests()
  while (cleanups.length > 0) cleanups.pop()?.()
  vi.useRealTimers()
})

function dispatchFocus(doc: Document, win: Window, type: 'focusin' | 'focusout'): void {
  doc.dispatchEvent(new win.Event(type, { bubbles: true }) as unknown as globalThis.Event)
}

function surfaceKeyOf(call: unknown[]): string | undefined {
  const surface = call[0] as { surfaceKey?: string } | undefined
  return surface?.surfaceKey
}

function mountDocument(doc: Document, vim: { activateSurface: ReturnType<typeof vi.fn> }) {
  const services = new ServiceCollection()
  const context = new ContextKeyService()
  services.set(IContextKeyService, context)
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: async () => undefined,
  } as never)
  services.set(IKeyboardDebugService, {
    _serviceBrand: undefined,
    enabled: false,
    onDidChange: Event.None,
    toggle: () => false,
    append: () => undefined,
  } as never)
  services.set(IVimModeService, vim as never)
  const instantiation = new InstantiationService(services)
  function Host() {
    useVimDispatcher(doc)
    return null
  }
  return render(
    <ServicesContext.Provider value={instantiation}>
      <Host />
    </ServicesContext.Provider>,
  )
}

function listSurface(el: HTMLElement, key: string) {
  return {
    id: key,
    kind: 'list' as const,
    getElement: () => el,
    getSurfaceKey: () => key,
    defaultMode: 'normal' as const,
    actions: {},
  }
}

describe('useVimDispatcher across workbench documents', () => {
  it('publishes only the focused document and re-evaluates on document switches', () => {
    vi.useFakeTimers()
    const mainWin = new Window()
    const auxWin = new Window()
    const mainDoc = mainWin.document as unknown as Document
    const auxDoc = auxWin.document as unknown as Document

    const mainRegistration = registerWorkbenchDocument(mainDoc)
    const auxRegistration = registerWorkbenchDocument(auxDoc)
    cleanups.push(() => {
      mainRegistration.dispose()
      auxRegistration.dispose()
    })
    setActiveWorkbenchDocument(mainDoc)

    const mainEl = mainDoc.createElement('div')
    mainEl.tabIndex = 0
    mainDoc.body.appendChild(mainEl)
    const auxEl = auxDoc.createElement('div')
    auxEl.tabIndex = 0
    auxDoc.body.appendChild(auxEl)
    registerVimSurface(listSurface(mainEl, 'list:main'), mainDoc)
    registerVimSurface(listSurface(auxEl, 'list:aux'), auxDoc)

    mainEl.focus()
    auxEl.focus()

    const vim = { activateSurface: vi.fn() }
    const view = mountDocument(mainDoc, vim)
    mountDocument(auxDoc, vim)

    // Main is active; the auxiliary render must not have overwritten it.
    expect(surfaceKeyOf(vim.activateSurface.mock.calls.at(-1) ?? [])).toBe('list:main')

    // Focus moves to the auxiliary window: the main focusout refresh is
    // deferred, and when it lands it must see that it is no longer active.
    setActiveWorkbenchDocument(auxDoc)
    dispatchFocus(mainDoc, mainWin, 'focusout')
    dispatchFocus(auxDoc, auxWin, 'focusin')
    expect(surfaceKeyOf(vim.activateSurface.mock.calls.at(-1) ?? [])).toBe('list:aux')

    vi.runAllTimers()
    expect(surfaceKeyOf(vim.activateSurface.mock.calls.at(-1) ?? [])).toBe('list:aux')

    // Back to the main window.
    setActiveWorkbenchDocument(mainDoc)
    dispatchFocus(auxDoc, auxWin, 'focusout')
    dispatchFocus(mainDoc, mainWin, 'focusin')
    vi.runAllTimers()
    expect(surfaceKeyOf(vim.activateSurface.mock.calls.at(-1) ?? [])).toBe('list:main')

    view.unmount()
  })
})
