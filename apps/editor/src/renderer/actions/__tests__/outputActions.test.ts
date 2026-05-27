import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IOutputService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
  type IStorageService,
} from '@universe-editor/platform'
import { OutputService } from '../../services/output/OutputService.js'
import { ClearOutputAction } from '../logActions.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(undefined),
    remove: () => Promise.resolve(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

async function runCommand(id: string, services: ServiceCollection): Promise<void> {
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    await CommandsRegistry.getCommand(id)!.handler(accessor)
  })
}

describe('ClearOutputAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length) disposables.pop()?.dispose()
  })

  it('registers under MenuId.ViewContainerTitle for the Output container', () => {
    disposables.push(registerAction2(ClearOutputAction))

    const items = MenuRegistry.getMenuItems(MenuId.ViewContainerTitle)
    const item = items.find((it) => 'command' in it && it.command === ClearOutputAction.ID)
    expect(item).toBeDefined()
    expect(item).toMatchObject({ icon: 'trash-2' })
  })

  it('follows the active container regardless of header location', () => {
    disposables.push(registerAction2(ClearOutputAction))

    const ctx = new ContextKeyService()
    disposables.push(ctx)

    const matches = () =>
      MenuRegistry.getMenuItems(MenuId.ViewContainerTitle, ctx).some(
        (it) => 'command' in it && it.command === ClearOutputAction.ID,
      )

    expect(matches()).toBe(false)
    ctx.set('activeViewContainer', 'workbench.view.output')
    expect(matches()).toBe(true)
    ctx.set('activeViewContainer', 'workbench.view.search')
    expect(matches()).toBe(false)
  })

  it('clears the active channel when invoked', async () => {
    disposables.push(registerAction2(ClearOutputAction))

    const outputService = new OutputService(makeStorage())
    const channel = outputService.createChannel('Renderer')
    channel.appendLine('content')
    outputService.setActiveChannel('Renderer')

    const services = new ServiceCollection()
    services.set(IOutputService, outputService)
    await runCommand(ClearOutputAction.ID, services)

    expect(outputService.activeChannelContent.get()).toBe('')
  })

  it('is a no-op when no channel is active', async () => {
    disposables.push(registerAction2(ClearOutputAction))

    const outputService = new OutputService(makeStorage())
    const services = new ServiceCollection()
    services.set(IOutputService, outputService)
    await expect(runCommand(ClearOutputAction.ID, services)).resolves.toBeUndefined()
  })
})
