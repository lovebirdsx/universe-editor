/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Verifies ActiveRepoSyncContribution broadcasts the SCM view's selected repo
 *  to every provider host via `<providerId>.setActiveRepo`: the selected repo's
 *  owner gets its rootUri, every other provider gets undefined (hide), using
 *  the same selected-or-first fallback as ScmView / ScmViewToolbar.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
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
    store.add(CommandsRegistry.registerCommand('git.setActiveRepo', () => undefined))
    const scm = makeFakeScm([sc('/a'), sc('/b')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    expect(cmd.calls).toEqual([['git.setActiveRepo', ['/a']]])
    store.dispose()
  })

  it('pushes the selected repo and updates on selection change', () => {
    const store = new DisposableStore()
    store.add(CommandsRegistry.registerCommand('git.setActiveRepo', () => undefined))
    const scm = makeFakeScm([sc('/a'), sc('/b')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    scmViewState.setSelectedRepo('/b')
    expect(cmd.calls.at(-1)).toEqual(['git.setActiveRepo', ['/b']])
    store.dispose()
  })

  it('does not re-push the same repo', () => {
    const store = new DisposableStore()
    store.add(CommandsRegistry.registerCommand('git.setActiveRepo', () => undefined))
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
    store.add(CommandsRegistry.registerCommand('git.setActiveRepo', () => undefined))
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
    store.add(CommandsRegistry.registerCommand('perforce.setActiveRepo', () => undefined))
    const scm = makeFakeScm([sc('/depot', 'perforce')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    expect(cmd.calls).toEqual([['perforce.setActiveRepo', ['/depot']]])
    store.dispose()
  })

  // Repro for "command not found: git.setActiveRepo" at startup: the SCM provider
  // registers with the view before its host registers `setActiveRepo` (activation
  // is async), so the first push raced the command registration.
  it('defers the push until the provider registers its setActiveRepo command', () => {
    const store = new DisposableStore()
    const scm = makeFakeScm([sc('/a')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    // Command not registered yet: nothing pushed, no "command not found" call.
    expect(cmd.calls).toEqual([])

    store.add(CommandsRegistry.registerCommand('git.setActiveRepo', () => undefined))
    expect(cmd.calls).toEqual([['git.setActiveRepo', ['/a']]])
    store.dispose()
  })

  it('stays silent for a provider that never registers setActiveRepo', () => {
    const store = new DisposableStore()
    const scm = makeFakeScm([sc('/a')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    // An unrelated command registration must not trigger a bogus push.
    store.add(CommandsRegistry.registerCommand('unrelated.command', () => undefined))
    expect(cmd.calls).toEqual([])
    store.dispose()
  })

  it('broadcasts undefined to every provider whose repo is not selected', () => {
    const store = new DisposableStore()
    store.add(CommandsRegistry.registerCommand('git.setActiveRepo', () => undefined))
    store.add(CommandsRegistry.registerCommand('perforce.setActiveRepo', () => undefined))
    const scm = makeFakeScm([sc('/repo', 'git'), sc('/depot', 'perforce')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    // git is the first repo → selected; perforce must be told it isn't.
    expect(cmd.calls).toEqual([
      ['git.setActiveRepo', ['/repo']],
      ['perforce.setActiveRepo', [undefined]],
    ])

    // Selecting the p4 repo flips both messages.
    scmViewState.setSelectedRepo('/depot')
    expect(cmd.calls.at(-2)).toEqual(['git.setActiveRepo', [undefined]])
    expect(cmd.calls.at(-1)).toEqual(['perforce.setActiveRepo', ['/depot']])
    store.dispose()
  })

  it('sends a single message per provider even when it owns several repos', () => {
    const store = new DisposableStore()
    store.add(CommandsRegistry.registerCommand('git.setActiveRepo', () => undefined))
    store.add(CommandsRegistry.registerCommand('perforce.setActiveRepo', () => undefined))
    const scm = makeFakeScm([sc('/main', 'git'), sc('/sub', 'git'), sc('/depot', 'perforce')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))

    scmViewState.setSelectedRepo('/sub')
    // One git message (the selected repo), not one per repo.
    expect(cmd.calls).toEqual([
      ['git.setActiveRepo', ['/main']],
      ['perforce.setActiveRepo', [undefined]],
      ['git.setActiveRepo', ['/sub']],
    ])
    store.dispose()
  })

  it('re-pushes each pending provider once its command registers', () => {
    const store = new DisposableStore()
    const scm = makeFakeScm([sc('/repo', 'git'), sc('/depot', 'perforce')])
    const cmd = makeFakeCommands()
    store.add(new ActiveRepoSyncContribution(scm.service, cmd.service))
    expect(cmd.calls).toEqual([])

    store.add(CommandsRegistry.registerCommand('git.setActiveRepo', () => undefined))
    expect(cmd.calls).toEqual([['git.setActiveRepo', ['/repo']]])

    // The undefined (hide) push for the unselected provider retries too.
    store.add(CommandsRegistry.registerCommand('perforce.setActiveRepo', () => undefined))
    expect(cmd.calls.at(-1)).toEqual(['perforce.setActiveRepo', [undefined]])
    store.dispose()
  })
})
