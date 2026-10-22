/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The toolbar-button branch of IQuickInputService.pick(): `pick()`'s button
 *  handler dismisses the panel and resolves `undefined`, unlike createQuickPick's
 *  (which keeps it open). QuickPickPanel refocuses the input after firing either
 *  handler, so this pins the dismissing path's contract: no throw, one close, and
 *  the promise still settling with `undefined`.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
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
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <QuickInputPortal />
    </ServicesContext.Provider>,
  )
  return svc
}

afterEach(() => cleanup())

describe('QuickInputService.pick toolbar button', () => {
  it('dismisses the picker and resolves undefined when its button is triggered', async () => {
    const svc = renderPortal()
    const onDidTriggerButton = vi.fn()

    let picked: Promise<{ id: string } | undefined> | undefined
    await act(async () => {
      picked = svc.pick([{ id: 'a', label: 'Alpha' }], {
        buttons: [{ id: 'manage', iconId: 'gear', tooltip: 'Open Settings…' }],
        onDidTriggerButton,
      }) as Promise<{ id: string } | undefined>
    })
    expect(screen.getByTestId('quick-input-field')).toBeTruthy()

    fireEvent.click(screen.getByTestId('quick-input-button'))

    expect(onDidTriggerButton).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('quick-input-field')).toBeNull()
    await expect(picked).resolves.toBeUndefined()
  })
})

describe('QuickInputPortal escape handling', () => {
  it('leaves the picker open while a renderer dialog is above it', async () => {
    const svc = renderPortal()
    await act(async () => {
      void svc.pick([{ id: 'a', label: 'Alpha' }])
    })
    expect(screen.getByTestId('quick-input-field')).toBeTruthy()

    // A confirmation dialog raised from a row owns Escape; the picker's own
    // document listener runs first and must not close the list behind it.
    const dialog = document.createElement('div')
    dialog.setAttribute('data-renderer-dialog', '')
    document.body.appendChild(dialog)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('quick-input-field')).toBeTruthy()

    dialog.remove()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('quick-input-field')).toBeNull()
  })
})
