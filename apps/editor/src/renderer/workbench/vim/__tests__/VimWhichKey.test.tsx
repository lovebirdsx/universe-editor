/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Which-key overlay: renders the service state into the focused workbench document,
 *  follows updates, and removes itself on clear / unmount.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { act, cleanup, render } from '@testing-library/react'
import { Emitter, InstantiationService, ServiceCollection } from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { IVimModeService, type IVimWhichKeyState } from '../../../services/vim/vimModeService.js'
import {
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
} from '../../../services/windows/workbenchDocuments.js'
import { VimWhichKey } from '../VimWhichKey.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanup()
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fakeVim(initial?: IVimWhichKeyState) {
  const emitter = new Emitter<IVimWhichKeyState | undefined>()
  const vim = {
    _serviceBrand: undefined,
    whichKey: initial,
    onDidChangeWhichKey: emitter.event,
    set(state: IVimWhichKeyState | undefined) {
      vim.whichKey = state
      emitter.fire(state)
    },
  }
  return { vim, emitter }
}

function mount(vim: unknown) {
  const services = new ServiceCollection()
  services.set(IVimModeService, vim as never)
  return render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <VimWhichKey />
    </ServicesContext.Provider>,
  )
}

const STATE: IVimWhichKeyState = {
  prefix: '<Space>',
  items: [
    { key: 'e', title: 'Show Explorer', isGroup: false },
    { key: 'w', title: '+3', isGroup: true },
  ],
}

describe('VimWhichKey', () => {
  it('renders nothing while there is no state', () => {
    const { vim } = fakeVim()
    mount(vim)
    expect(document.querySelector('[data-testid="vim-which-key"]')).toBeNull()
  })

  it('renders the prefix and every item when state already exists on mount', () => {
    const { vim } = fakeVim(STATE)
    mount(vim)
    expect(document.querySelector('[data-testid="vim-which-key-prefix"]')?.textContent).toBe(
      '<Space>',
    )
    const items = [...document.querySelectorAll('[data-testid="vim-which-key-item"]')]
    expect(items.map((item) => item.textContent)).toEqual(['eShow Explorer', 'w+3'])
  })

  it('shows, updates and hides as the service state changes', () => {
    const { vim } = fakeVim()
    mount(vim)
    act(() => vim.set(STATE))
    expect(document.querySelectorAll('[data-testid="vim-which-key-item"]')).toHaveLength(2)

    act(() => vim.set({ prefix: '<Space>w', items: [{ key: 'h', title: 'Left', isGroup: false }] }))
    expect(document.querySelector('[data-testid="vim-which-key-prefix"]')?.textContent).toBe(
      '<Space>w',
    )
    expect(document.querySelectorAll('[data-testid="vim-which-key-item"]')).toHaveLength(1)

    act(() => vim.set(undefined))
    expect(document.querySelector('[data-testid="vim-which-key"]')).toBeNull()
  })

  it('unsubscribes on unmount and removes the portal', () => {
    const { vim, emitter } = fakeVim(STATE)
    const view = mount(vim)
    expect(document.querySelector('[data-testid="vim-which-key"]')).not.toBeNull()
    view.unmount()
    expect(document.querySelector('[data-testid="vim-which-key"]')).toBeNull()
    // nobody listens any more: firing must not throw or re-render
    expect(() => emitter.fire(STATE)).not.toThrow()
    expect(document.querySelector('[data-testid="vim-which-key"]')).toBeNull()
  })

  it('portals into the focused workbench document', () => {
    const aux = new Window().document as unknown as Document
    const registration = registerWorkbenchDocument(aux)
    cleanups.push(() => {
      setActiveWorkbenchDocument(document)
      registration.dispose()
    })
    setActiveWorkbenchDocument(aux)
    const { vim } = fakeVim(STATE)
    mount(vim)
    expect(aux.querySelector('[data-testid="vim-which-key"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="vim-which-key"]')).toBeNull()
  })
})
