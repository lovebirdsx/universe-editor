/*---------------------------------------------------------------------------------------------
 *  Tests for RevealActiveFileInExplorerAction (主题 11 WP6).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IEditorGroupsService,
  IViewsService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
  registerAction2,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IObservable,
  type IViewsService as IViewsServiceType,
} from '@universe-editor/platform'
import { RevealActiveFileInExplorerAction } from '../revealActions.js'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
} from '../../workbench/explorer/ExplorerTreeService.js'
import { FileEditorInput } from '../../workbench/editor/FileEditorInput.js'
import { UntitledEditorInput } from '../../workbench/editor/UntitledEditorInput.js'

function makeFileInput(uri: URI): FileEditorInput {
  const input = Object.create(FileEditorInput.prototype) as FileEditorInput
  Object.defineProperty(input, 'resource', { get: () => uri })
  Object.defineProperty(input, 'typeId', { get: () => 'file' })
  return input
}

function makeGroups(active?: EditorInput): IEditorGroupsServiceType {
  const group = { activeEditor: active } as unknown as IEditorGroup
  return { activeGroup: group } as unknown as IEditorGroupsServiceType
}

class FakeViews implements IViewsServiceType {
  declare readonly _serviceBrand: undefined
  readonly openedContainers: string[] = []
  readonly activeContainerByLocation: IObservable<Readonly<Record<number, string | undefined>>> =
    observableValue('views.active', {})
  openViewContainer(containerId: string): void {
    this.openedContainers.push(containerId)
  }
  closeViewContainer(): void {}
  getActiveViewContainerId(): string | undefined {
    return undefined
  }
}

class FakeExplorerTree {
  declare readonly _serviceBrand: undefined
  readonly revealed: string[] = []
  readonly onDidChange = new Emitter<void>().event
  async reveal(target: URI): Promise<boolean> {
    this.revealed.push(target.toString())
    return true
  }
}

function makeHarness(active?: EditorInput) {
  const views = new FakeViews()
  const tree = new FakeExplorerTree()
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, makeGroups(active))
  services.set(IViewsService, views)
  services.set(IExplorerTreeService, tree as unknown as ExplorerTreeService)
  const inst = new InstantiationService(services)
  return { inst, views, tree }
}

function run(inst: InstantiationService, id: string, args?: unknown): Promise<unknown> {
  const cmd = CommandsRegistry.getCommand(id)
  if (!cmd) throw new Error(`Command ${id} not registered`)
  return inst.invokeFunction((accessor) => cmd.handler(accessor, args)) as Promise<unknown>
}

const disposables: Array<{ dispose(): void }> = []
beforeEach(() => {
  disposables.push(registerAction2(RevealActiveFileInExplorerAction))
})
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

describe('RevealActiveFileInExplorerAction', () => {
  it('opens the explorer container and reveals the active FileEditorInput', async () => {
    const target = URI.file('/ws/src/main.ts')
    const input = makeFileInput(target)
    const h = makeHarness(input)
    await run(h.inst, RevealActiveFileInExplorerAction.ID)
    expect(h.views.openedContainers).toEqual(['workbench.view.explorer'])
    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('uses the resource argument when given (tab right-click)', async () => {
    const target = URI.file('/ws/lib/util.ts')
    const h = makeHarness()
    await run(h.inst, RevealActiveFileInExplorerAction.ID, { resource: target.toJSON() })
    expect(h.views.openedContainers).toEqual(['workbench.view.explorer'])
    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('does nothing when the active editor is untitled', async () => {
    const untitled = new UntitledEditorInput()
    const h = makeHarness(untitled)
    await run(h.inst, RevealActiveFileInExplorerAction.ID)
    expect(h.views.openedContainers).toHaveLength(0)
    expect(h.tree.revealed).toHaveLength(0)
  })

  it('does nothing when there is no active editor and no argument', async () => {
    const h = makeHarness()
    await run(h.inst, RevealActiveFileInExplorerAction.ID)
    expect(h.views.openedContainers).toHaveLength(0)
    expect(h.tree.revealed).toHaveLength(0)
  })
})
