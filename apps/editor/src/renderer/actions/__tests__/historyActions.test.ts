import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IContextKeyService,
  IEditorGroupsService,
  IFileService,
  IHistoryService,
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  registerAction2,
  type IDisposable,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { GoBackAction, GoForwardAction } from '../historyActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { HistoryService } from '../../services/history/HistoryService.js'

function makeFakeFileService(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  }
}

function setup() {
  FileEditorRegistry._resetForTests()
  const groups = new EditorGroupsService()
  const history = new HistoryService(new UriIdentityService('linux'))

  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IHistoryService, history)
  services.set(IFileService, makeFakeFileService())
  services.set(IContextKeyService, new ContextKeyService())
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return { groups, history, inst }
}

async function runCommand(
  inst: InstantiationService,
  ctor: new () => unknown,
  disposables: IDisposable[],
): Promise<void> {
  disposables.push(registerAction2(ctor as never))
  const id = (ctor as unknown as { ID: string }).ID
  const cmd = CommandsRegistry.getCommand(id)
  if (!cmd) throw new Error(`command not registered: ${id}`)
  await inst.invokeFunction(async (accessor) => {
    await cmd.handler(accessor)
  })
}

describe('History navigation actions', () => {
  const disposables: IDisposable[] = []

  beforeEach(() => {
    FileEditorRegistry._resetForTests()
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    FileEditorRegistry._resetForTests()
  })

  it('GoBack returns to a file that was replaced in the preview slot — reuses the slot instead of opening a duplicate', async () => {
    const { groups, history, inst } = setup()
    const uriA = URI.file('/repo/a.ts')
    const uriB = URI.file('/repo/b.ts')

    // Step 1: open a as preview (Explorer single-click semantics).
    const inputA = inst.createInstance(FileEditorInput, uriA)
    groups.activeGroup.openEditor(inputA, { pinned: false, activate: true })

    // Step 2: cursor movement in a is recorded.
    history.record({
      resource: uriA,
      selection: { startLine: 12, startColumn: 1, endLine: 12, endColumn: 1 },
    })

    // Step 3: open b as preview — replaces a in the preview slot, a is disposed.
    const inputB = inst.createInstance(FileEditorInput, uriB)
    groups.activeGroup.openEditor(inputB, { pinned: false, activate: true })
    history.record({
      resource: uriB,
      selection: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    })

    expect(groups.activeGroup.editors).toHaveLength(1)
    expect(groups.activeGroup.activeEditor?.resource?.toString()).toBe(uriB.toString())
    expect(history.canGoBack()).toBe(true)

    // Step 4: GoBack should land back on a (replacing b in the preview slot),
    // NOT open a duplicate a alongside b.
    await runCommand(inst, GoBackAction, disposables)

    expect(groups.activeGroup.editors).toHaveLength(1)
    const active = groups.activeGroup.activeEditor
    expect(active).toBeDefined()
    expect(active?.resource?.toString()).toBe(uriA.toString())
  })

  it('GoBack activates the existing tab when the previous file is still open and pinned', async () => {
    const { groups, history, inst } = setup()
    const uriA = URI.file('/repo/a.ts')
    const uriB = URI.file('/repo/b.ts')

    const inputA = inst.createInstance(FileEditorInput, uriA)
    groups.activeGroup.openEditor(inputA, { pinned: true, activate: true })
    history.record({
      resource: uriA,
      selection: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 },
    })

    const inputB = inst.createInstance(FileEditorInput, uriB)
    groups.activeGroup.openEditor(inputB, { pinned: true, activate: true })
    history.record({
      resource: uriB,
      selection: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    })

    expect(groups.activeGroup.editors).toHaveLength(2)

    await runCommand(inst, GoBackAction, disposables)

    expect(groups.activeGroup.editors).toHaveLength(2)
    expect(groups.activeGroup.activeEditor).toBe(inputA)
  })

  it('GoForward after GoBack re-activates the later entry without duplicating tabs', async () => {
    const { groups, history, inst } = setup()
    const uriA = URI.file('/repo/a.ts')
    const uriB = URI.file('/repo/b.ts')

    const inputA = inst.createInstance(FileEditorInput, uriA)
    groups.activeGroup.openEditor(inputA, { pinned: false, activate: true })
    history.record({
      resource: uriA,
      selection: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 1 },
    })

    const inputB = inst.createInstance(FileEditorInput, uriB)
    groups.activeGroup.openEditor(inputB, { pinned: false, activate: true })
    history.record({
      resource: uriB,
      selection: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    })

    await runCommand(inst, GoBackAction, disposables)
    expect(groups.activeGroup.activeEditor?.resource?.toString()).toBe(uriA.toString())
    expect(history.canGoForward()).toBe(true)

    await runCommand(inst, GoForwardAction, disposables)
    expect(groups.activeGroup.editors).toHaveLength(1)
    expect(groups.activeGroup.activeEditor?.resource?.toString()).toBe(uriB.toString())
  })
})
