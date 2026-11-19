/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Focus-restore contract of the Quick Input portal. The overlay captures whatever
 *  held focus before it opened (the editor) and must hand it back on close. In dev
 *  ReactStrictMode replays setup→cleanup→setup for newly mounted components, so the
 *  rehearsal cleanup must not consume that captured target.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  Event,
  IContextKeyService,
  IQuickInputService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { QuickInputPortal } from '../QuickInput.js'
import { ServicesContext } from '../../useService.js'
import { QuickInputService } from '../../../services/quickInput/QuickInputService.js'

class FakeStorage implements IStorageServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _map = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this._map.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this._map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this._map.delete(key)
  }
}

function renderPortal(): QuickInputService {
  const services = new ServiceCollection()
  services.set(IStorageService, new FakeStorage())
  services.set(IContextKeyService, new ContextKeyService())
  const instantiation = new InstantiationService(services)
  const svc = instantiation.createInstance(QuickInputService)
  services.set(IQuickInputService, svc)
  render(
    <StrictMode>
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <QuickInputPortal />
      </ServicesContext.Provider>
    </StrictMode>,
  )
  return svc
}

function createFakeEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.className = 'monaco-editor native-edit-context'
  editor.tabIndex = 0
  editor.setAttribute('data-testid', 'fake-editor')
  document.body.appendChild(editor)
  editor.focus()
  return editor
}

afterEach(() => {
  cleanup()
  document.body.querySelectorAll('[data-testid="fake-editor"]').forEach((node) => node.remove())
})

describe('QuickInputPortal focus restore under StrictMode', () => {
  it('returns focus to the editor after the picker is hidden', async () => {
    const svc = renderPortal()
    const editor = createFakeEditor()

    await act(async () => {
      void svc.pick([{ id: 'a', label: 'Alpha' }])
    })
    expect(screen.getByTestId('quick-input-field')).toBe(document.activeElement)

    await act(async () => {
      svc.hide()
    })
    await Promise.resolve()
    expect(screen.queryByTestId('quick-input-field')).toBeNull()
    expect(document.activeElement).toBe(editor)
  })

  it('returns focus to the editor after closing with Escape', async () => {
    const svc = renderPortal()
    const editor = createFakeEditor()

    await act(async () => {
      void svc.pick([{ id: 'a', label: 'Alpha' }])
    })
    expect(screen.getByTestId('quick-input-field')).toBe(document.activeElement)

    fireEvent.keyDown(document, { key: 'Escape' })
    await Promise.resolve()
    expect(screen.queryByTestId('quick-input-field')).toBeNull()
    expect(document.activeElement).toBe(editor)
  })
})
