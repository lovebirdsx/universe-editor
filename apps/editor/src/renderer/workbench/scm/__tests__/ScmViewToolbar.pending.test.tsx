/*---------------------------------------------------------------------------------------------
 *  Clicking a title-bar action (e.g. Refresh) disables the button and swaps its
 *  icon to a spinner until the command's promise settles, so a slow sync can't
 *  be re-triggered mid-flight and the progress hint sits where the user clicked.
 *  The pending key is repo-scoped: one repo's in-flight command must not lock
 *  another repo's button.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  ICommandService,
  MenuId,
  MenuRegistry,
  type ICommandService as ICommandServiceType,
  type IDisposable,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { ScmViewToolbar } from '../ScmViewToolbar.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'
import { scmViewState } from '../scmViewState.js'

const REPO_A = 'D:/repo'
const REPO_B = 'D:/repo2'

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
  const scm = new ScmService()
  const stubCommand: ICommandServiceType = { _serviceBrand: undefined, executeCommand }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ScmViewToolbar />
    </ServicesContext.Provider>,
  )
  return { scm }
}

async function registerRepo(scm: ScmService, handle: number, rootUri: string): Promise<void> {
  await act(async () => {
    await scm.$registerSourceControl(handle, 'perforce', 'Perforce', rootUri)
  })
}

describe('ScmViewToolbar — button busy while command in flight', () => {
  let menuItem: IDisposable

  beforeAll(() => {
    menuItem = MenuRegistry.addMenuItem(MenuId.ScmTitle, {
      command: 'perforce.refresh',
      title: 'Refresh',
      group: 'navigation',
      icon: 'refresh',
    })
  })
  afterAll(() => menuItem.dispose())
  afterEach(() => scmViewState.setSelectedRepo(undefined))

  it('disables the button with a spinner until the command settles', async () => {
    const d = deferred<undefined>()
    const executeCommand = vi.fn().mockImplementation(() => d.promise)
    const { scm } = setup(executeCommand)
    await registerRepo(scm, 0, REPO_A)

    const btn = await screen.findByTestId('scm-title-action-perforce.refresh')
    expect((btn as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(btn)
    expect(executeCommand).toHaveBeenCalledWith('perforce.refresh', {
      rootUri: REPO_A,
      sourceControlId: 'perforce',
    })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    // The button's own icon spins while in flight (the git syncing idiom).
    expect(btn.querySelector('[data-testid="scm-title-action-spin"]')).not.toBeNull()

    // Settling the command restores the button.
    await act(async () => {
      d.resolve(undefined)
      await d.promise
    })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
    expect(btn.querySelector('[data-testid="scm-title-action-spin"]')).toBeNull()
  })

  it('recovers the button when the command fails', async () => {
    const d = deferred<undefined>()
    const { scm } = setup(vi.fn().mockImplementation(() => d.promise))
    await registerRepo(scm, 0, REPO_A)

    const btn = await screen.findByTestId('scm-title-action-perforce.refresh')
    fireEvent.click(btn)
    expect((btn as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      d.reject(new Error('p4 down'))
      await d.promise.catch(() => undefined)
    })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })

  it("one repo's in-flight refresh does not lock another repo's button", async () => {
    const d = deferred<undefined>()
    const { scm } = setup(vi.fn().mockImplementation(() => d.promise))
    await registerRepo(scm, 0, REPO_A)
    await registerRepo(scm, 1, REPO_B)

    const btn = await screen.findByTestId('scm-title-action-perforce.refresh')
    fireEvent.click(btn) // refresh REPO_A (selected by default) — stays in flight
    expect((btn as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      scmViewState.setSelectedRepo(REPO_B)
    })
    expect((btn as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      scmViewState.setSelectedRepo(REPO_A)
    })
    expect((btn as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      d.resolve(undefined)
      await d.promise
    })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })
})
