/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the `_workbench.openGitGraph` / `_workbench.openPerforceGraph`
 *  bridge actions: always open the graph editor, then either hand the target
 *  to the mounted editor's revealCommit or stash it in pendingReveal.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorService,
  InstantiationService,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { gitGraphViewState } from '../../services/gitGraph/gitGraphViewState.js'
import { perforceGraphViewState } from '../../services/perforceGraph/perforceGraphViewState.js'
import { OpenGitGraphFromExtensionAction } from '../gitGraphActions.js'
import { OpenPerforceGraphFromExtensionAction } from '../perforceGraphActions.js'

const HASH = '1111111111111111111111111111111111111111'

describe('graph reveal bridge actions', () => {
  const disposables: IDisposable[] = []
  let openEditor: ReturnType<typeof vi.fn>

  function setup(): void {
    disposables.push(registerAction2(OpenGitGraphFromExtensionAction))
    disposables.push(registerAction2(OpenPerforceGraphFromExtensionAction))
    openEditor = vi.fn(async () => undefined)
  }

  async function run(id: string, ...args: unknown[]): Promise<void> {
    const services = new ServiceCollection()
    services.set(IEditorService, {
      _serviceBrand: undefined,
      openEditor,
    } as unknown as IEditorService)
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      await CommandsRegistry.getCommand(id)!.handler(accessor, ...args)
    })
  }

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    gitGraphViewState.revealCommit = null
    gitGraphViewState.pendingReveal = null
    perforceGraphViewState.revealCommit = null
    perforceGraphViewState.pendingReveal = null
    vi.clearAllMocks()
  })

  it('opens the git graph and reveals via the mounted editor callback', async () => {
    setup()
    const revealCommit = vi.fn()
    gitGraphViewState.revealCommit = revealCommit

    await run(OpenGitGraphFromExtensionAction.ID, HASH)

    expect(openEditor).toHaveBeenCalledTimes(1)
    expect(revealCommit).toHaveBeenCalledWith(HASH)
    expect(gitGraphViewState.pendingReveal).toBeNull()
  })

  it('stashes the hash in pendingReveal while the git graph is unmounted', async () => {
    setup()

    await run(OpenGitGraphFromExtensionAction.ID, HASH)

    expect(openEditor).toHaveBeenCalledTimes(1)
    expect(gitGraphViewState.pendingReveal).toBe(HASH)
  })

  it('opens the git graph without a reveal for a missing/invalid hash', async () => {
    setup()

    await run(OpenGitGraphFromExtensionAction.ID)
    await run(OpenGitGraphFromExtensionAction.ID, '')

    expect(openEditor).toHaveBeenCalledTimes(2)
    expect(gitGraphViewState.pendingReveal).toBeNull()
  })

  it('opens the perforce graph and reveals via the mounted editor callback', async () => {
    setup()
    const revealCommit = vi.fn()
    perforceGraphViewState.revealCommit = revealCommit

    await run(OpenPerforceGraphFromExtensionAction.ID, '4521')

    expect(openEditor).toHaveBeenCalledTimes(1)
    expect(revealCommit).toHaveBeenCalledWith('4521')
    expect(perforceGraphViewState.pendingReveal).toBeNull()
  })

  it('stashes the changelist in pendingReveal while the perforce graph is unmounted', async () => {
    setup()

    await run(OpenPerforceGraphFromExtensionAction.ID, '4521')

    expect(openEditor).toHaveBeenCalledTimes(1)
    expect(perforceGraphViewState.pendingReveal).toBe('4521')
  })
})
