/*---------------------------------------------------------------------------------------------
 *  Clicking a view-title action disables the button and spins its own icon
 *  until the command's promise settles (the git syncing idiom), so a
 *  long-running action like a view refresh can't be re-triggered mid-flight.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  ICommandService,
  MenuId,
  MenuRegistry,
  type ICommandService as ICommandServiceType,
  type IDisposable,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { ViewTitleActions } from '../ViewTitleActions.js'
import { ServicesContext } from '../../useService.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(executeCommand: ICommandServiceType['executeCommand']) {
  const stubCommand: ICommandServiceType = { _serviceBrand: undefined, executeCommand }
  const services = new ServiceCollection()
  services.set(ICommandService, stubCommand)
  const inst = new InstantiationService(services)
  const ctx = new ContextKeyService()
  ctx.createKey('view', 'test.view')
  render(
    <ServicesContext.Provider value={inst}>
      <ViewTitleActions menuId={MenuId.ViewTitle} contextKeyService={ctx} />
    </ServicesContext.Provider>,
  )
}

describe('ViewTitleActions — button busy while command in flight', () => {
  let menuItem: IDisposable

  beforeAll(() => {
    menuItem = MenuRegistry.addMenuItem(MenuId.ViewTitle, {
      command: 'test.refresh',
      title: 'Refresh',
      group: 'navigation',
      icon: 'refresh',
    })
  })
  afterAll(() => menuItem.dispose())

  it('disables the button and spins its own icon until the command settles', async () => {
    const d = deferred<undefined>()
    const executeCommand = vi.fn().mockImplementation(() => d.promise)
    setup(executeCommand)

    const btn = await screen.findByTestId('view-title-action-test.refresh')
    expect((btn as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(btn)
    expect(executeCommand).toHaveBeenCalledWith('test.refresh', 'test.view')
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn.querySelector('[data-testid="view-title-action-spin"]')).not.toBeNull()

    // A second click while in flight is a no-op (the button is disabled).
    fireEvent.click(btn)
    expect(executeCommand).toHaveBeenCalledTimes(1)

    await act(async () => {
      d.resolve(undefined)
      await d.promise
    })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
    expect(btn.querySelector('[data-testid="view-title-action-spin"]')).toBeNull()
  })

  it('recovers the button when the command fails', async () => {
    const d = deferred<undefined>()
    setup(vi.fn().mockImplementation(() => d.promise))

    const btn = await screen.findByTestId('view-title-action-test.refresh')
    fireEvent.click(btn)
    expect((btn as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      d.reject(new Error('boom'))
      await d.promise.catch(() => undefined)
    })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })
})
