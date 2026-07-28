import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IQuickInputService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { IScmService, type IScmSourceControlModel } from '../../services/extensions/ScmService.js'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import { SwitchScmRepoAction } from '../scmActions.js'

function makeSourceControl(handle: number, rootUri: string): IScmSourceControlModel {
  const name = rootUri.slice(rootUri.lastIndexOf('/') + 1)
  return { handle, id: 'git', label: name, rootUri } as IScmSourceControlModel
}

const repoA = makeSourceControl(1, '/ws/repo-a')
const repoB = makeSourceControl(2, '/ws/repo-b')

function makeScmService(sourceControls: readonly IScmSourceControlModel[]) {
  return {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.scm.sourceControls', sourceControls),
  }
}

async function runCommand(id: string, services: ServiceCollection): Promise<void> {
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    await CommandsRegistry.getCommand(id)!.handler(accessor)
  })
}

describe('SwitchScmRepoAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    scmViewState.setSelectedRepo(undefined)
    vi.clearAllMocks()
  })

  it('switches the selected repo to the picked one', async () => {
    disposables.push(registerAction2(SwitchScmRepoAction))
    scmViewState.setSelectedRepo(repoA.rootUri)
    const pick = vi.fn(async (items: readonly { label: string }[]) => items[1])
    const services = new ServiceCollection()
    services.set(IScmService, makeScmService([repoA, repoB]) as never)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)

    await runCommand(SwitchScmRepoAction.ID, services)

    expect(pick).toHaveBeenCalledTimes(1)
    expect(scmViewState.selectedRepo.get()).toBe(repoB.rootUri)
  })

  it('marks the current repo with a check icon', async () => {
    disposables.push(registerAction2(SwitchScmRepoAction))
    scmViewState.setSelectedRepo(repoB.rootUri)
    let offered: readonly { label: string; iconId?: string }[] = []
    const pick = vi.fn(async (items: readonly { label: string; iconId?: string }[]) => {
      offered = items
      return undefined
    })
    const services = new ServiceCollection()
    services.set(IScmService, makeScmService([repoA, repoB]) as never)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)

    await runCommand(SwitchScmRepoAction.ID, services)

    expect(offered.map((i) => i.iconId)).toEqual([undefined, 'check'])
    expect(scmViewState.selectedRepo.get()).toBe(repoB.rootUri)
  })

  it('is a no-op with a single repo', async () => {
    disposables.push(registerAction2(SwitchScmRepoAction))
    const pick = vi.fn()
    const services = new ServiceCollection()
    services.set(IScmService, makeScmService([repoA]) as never)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)

    await runCommand(SwitchScmRepoAction.ID, services)

    expect(pick).not.toHaveBeenCalled()
    expect(scmViewState.selectedRepo.get()).toBeUndefined()
  })
})
