/*---------------------------------------------------------------------------------------------
 *  Tests for the HTML preview actions — mirrors the markdown ones, since both
 *  share togglePreviewInGroup.
 *
 *  Previews of different files coexist as separate tabs (a.html's preview is
 *  not retargeted at b.html), and the toggle preview inherits the source tab's
 *  pin state (slot in → slot, pinned in → pinned).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IContextKeyService,
  IEditorGroupsService,
  IFileService,
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { OpenHtmlPreviewAction, OpenHtmlSourceAction } from '../htmlPreviewActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { HtmlPreviewInput } from '../../services/editor/HtmlPreviewInput.js'

function makeFakeFileService(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileHead() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return true
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
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IFileService, makeFakeFileService())
  services.set(IContextKeyService, new ContextKeyService())
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return { groups, inst }
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

describe('OpenHtmlPreviewAction — preview tab lifecycle', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    FileEditorRegistry._resetForTests()
  })

  it("adds a preview tab for another file's source without disposing the first preview", async () => {
    const { groups, inst } = setup()
    const group = groups.activeGroup
    const uriA = URI.file('/repo/a.html')
    const uriB = URI.file('/repo/b.html')

    const previewA = new HtmlPreviewInput(uriA)
    group.openEditor(previewA, { activate: true, pinned: true })
    const sourceA = inst.createInstance(FileEditorInput, uriA)
    group.openEditor(sourceA, { activate: true, pinned: true })
    const sourceB = inst.createInstance(FileEditorInput, uriB)
    group.openEditor(sourceB, { activate: true, pinned: true })

    await runCommand(inst, OpenHtmlPreviewAction, disposables)

    expect(group.editors).toHaveLength(3)
    const active = group.activeEditor
    expect(active).toBeInstanceOf(HtmlPreviewInput)
    expect((active as HtmlPreviewInput).sourceUri.toString()).toBe(uriB.toString())
    expect(group.editors[0]).toBe(previewA)
    expect(group.editors[1]).toBe(sourceA)
    expect(group.editors[2]).toBe(active)
    expect(previewA.isDisposed).toBe(false)
    expect(sourceA.isDisposed).toBe(false)
    expect(sourceB.isDisposed).toBe(false)
    expect((active as HtmlPreviewInput).sourceInput).toBe(sourceB)
  })

  it('toggles a preview-slot source into a preview that takes the slot', async () => {
    const { groups, inst } = setup()
    const group = groups.activeGroup
    const uri = URI.file('/repo/a.html')

    const source = inst.createInstance(FileEditorInput, uri)
    group.openEditor(source, { activate: true, pinned: false })

    await runCommand(inst, OpenHtmlPreviewAction, disposables)

    const active = group.activeEditor
    expect(active).toBeInstanceOf(HtmlPreviewInput)
    expect(group.editors).toHaveLength(1)
    expect(group.isPinned(active!)).toBe(false)
    expect(group.previewEditor).toBe(active)
    expect(source.isDisposed).toBe(false)
    expect((active as HtmlPreviewInput).sourceInput).toBe(source)
  })

  it('Open Source on a slot preview puts the source back in the slot (round trip)', async () => {
    const { groups, inst } = setup()
    const group = groups.activeGroup
    const uri = URI.file('/repo/a.html')

    const source = inst.createInstance(FileEditorInput, uri)
    group.openEditor(source, { activate: true, pinned: false })
    await runCommand(inst, OpenHtmlPreviewAction, disposables)
    const preview = group.activeEditor as HtmlPreviewInput
    expect(group.isPinned(preview)).toBe(false)

    await runCommand(inst, OpenHtmlSourceAction, disposables)

    expect(group.activeEditor).toBe(source)
    expect(group.editors).toHaveLength(1)
    expect(group.isPinned(source)).toBe(false)
    expect(group.previewEditor).toBe(source)
    expect(preview.isDisposed).toBe(true)
  })

  it("activates this file's existing preview without detaching its source", async () => {
    const { groups, inst } = setup()
    const group = groups.activeGroup
    const uri = URI.file('/repo/a.html')

    const preview = new HtmlPreviewInput(uri)
    group.openEditor(preview, { activate: true, pinned: true })
    const source = inst.createInstance(FileEditorInput, uri)
    group.openEditor(source, { activate: true, pinned: true })

    await runCommand(inst, OpenHtmlPreviewAction, disposables)

    expect(group.editors).toHaveLength(2)
    expect(group.activeEditor).toBe(preview)
    expect(group.contains(source)).toBe(true)
    expect(source.isDisposed).toBe(false)
  })
})
