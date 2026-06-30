/*---------------------------------------------------------------------------------------------
 *  Tests for markdown preview title-bar actions, focused on the link-navigated
 *  case: a preview opened from a clicked link (constructed from a URI, with no
 *  held source FileEditorInput). "Open Source" must still work — it has to open
 *  the source file, not silently do nothing.
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
import { OpenMarkdownSourceAction } from '../markdownActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'

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

describe('OpenMarkdownSourceAction — link-navigated preview', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    FileEditorRegistry._resetForTests()
  })

  it('opens the source file in place of a URI-constructed preview (no held source)', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')

    // Link-navigated preview: built from a URI, so it holds NO source input.
    const preview = new MarkdownPreviewInput(sourceUri)
    groups.activeGroup.openEditor(preview, { activate: true, pinned: true })
    expect(groups.activeGroup.editors).toHaveLength(1)
    expect(preview.sourceInput).toBeUndefined()

    await runCommand(inst, OpenMarkdownSourceAction, disposables)

    // The preview tab is replaced by the source file editor.
    expect(groups.activeGroup.editors).toHaveLength(1)
    const active = groups.activeGroup.activeEditor
    expect(active).toBeInstanceOf(FileEditorInput)
    expect(active?.resource?.toString()).toBe(sourceUri.toString())
  })

  it('activates an already-open source tab instead of opening a duplicate', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')

    const source = inst.createInstance(FileEditorInput, sourceUri)
    groups.activeGroup.openEditor(source, { activate: true, pinned: true })
    const preview = new MarkdownPreviewInput(sourceUri)
    groups.activeGroup.openEditor(preview, { activate: true, pinned: true })
    expect(groups.activeGroup.editors).toHaveLength(2)

    await runCommand(inst, OpenMarkdownSourceAction, disposables)

    // Existing source tab is activated; no third tab is created.
    expect(groups.activeGroup.activeEditor).toBe(source)
  })
})
