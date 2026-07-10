/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Verifies ActiveRepoSyncContribution mirrors the SCM view's selected repo to
 *  its provider host via `<providerId>.setActiveRepo`, using the same
 *  selected-or-first fallback as ScmView / ScmViewToolbar.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  DisposableStore,
  observableValue,
  type ICommandService,
  type IObservable,
} from '@universe-editor/platform'
import type { IScmService, IScmSourceControlModel } from '../../services/extensions/ScmService.js'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import { ActiveRepoSyncContribution } from '../ActiveRepoSyncContribution.js'

function sc(rootUri: string, id = 'git'): IScmSourceControlModel {
  return { id, rootUri } as unknown as IScmSourceControlModel
}

function makeFakeScm(initial: readonly IScmSourceControlModel[]): {
  service: IScmService
  set: (list: readonly IScmSourceControlModel[]) => void
} {
  const sourceControls = observableValue<readonly IScmSourceControlModel[]>(
    'sourceControls',
    initial,
  )
  const service: IScmService = {
    _serviceBrand: undefined,
    sourceControls: sourceControls as IObservable<readonly IScmSourceControlModel[]>,
    changeInputBoxValue() {},
    setExtHost() {},
    resetSourceControls() {},
  }
  return { service, set: (list) => sourceControls.set(list, undefined) }
}

function makeFakeCommands(): { service: ICommandService; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = []
  const service = {
    executeCommand: (command: string, ...args: unknown[]) => {
      calls.push([command, args])
      return Promise.resolve(undefined)
    },
  } as unknown as ICommandService
  return { service, calls }
}

describe('ActiveRepoSyncContribution', () => {
  afterEach(() => {
    scmViewState.setSelectedRepo(undefined)
  })

  it('pushes the first repo when no selection is set', () => {
    const store = new DisposableStore()
    const scm = makeFakeScm([sc('/a'), sc('/b')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    expect(cmd.calls).toEqual([['git.setActiveRepo', ['/a']]])
    store.dispose()
  })

  it('pushes the selected repo and updates on selection change', () => {
    const store = new DisposableStore()
    const scm = makeFakeScm([sc('/a'), sc('/b')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    scmViewState.setSelectedRepo('/b')
    expect(cmd.calls.at(-1)).toEqual(['git.setActiveRepo', ['/b']])
    store.dispose()
  })

  it('does not re-push the same repo', () => {
    const store = new DisposableStore()
    const scm = makeFakeScm([sc('/a'), sc('/b')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    const initial = cmd.calls.length
    // Re-selecting the already-active first repo's rootUri changes nothing.
    scmViewState.setSelectedRepo('/a')
    expect(cmd.calls.length).toBe(initial)
    store.dispose()
  })

  it('falls back to the first repo when the selection is no longer present', () => {
    const store = new DisposableStore()
    const scm = makeFakeScm([sc('/a'), sc('/b')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    scmViewState.setSelectedRepo('/b')
    // /b disappears (e.g. workspace change) → fall back to the new first repo.
    scm.set([sc('/c')])
    expect(cmd.calls.at(-1)).toEqual(['git.setActiveRepo', ['/c']])
    store.dispose()
  })

  it('derives the command id from the selected provider (not hardcoded git)', () => {
    const store = new DisposableStore()
    const scm = makeFakeScm([sc('/depot', 'perforce')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    expect(cmd.calls).toEqual([['perforce.setActiveRepo', ['/depot']]])
    store.dispose()
  })
})
