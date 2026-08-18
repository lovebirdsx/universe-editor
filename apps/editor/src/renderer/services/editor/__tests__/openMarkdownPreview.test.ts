/*---------------------------------------------------------------------------------------------
 *  Tests for openMarkdownPreviewInGroup — plain navigation between previews
 *  reuses the current preview tab in place (VSCode-style single-tab trail).
 *
 *  Regression guard: a toggle-mode preview holds its source FileEditorInput
 *  (detached, not disposed) so the Monaco model survives the toggle. Closing
 *  such a preview via a link jump must not cascade-dispose a *dirty* source —
 *  that would release the shared model and silently drop unsaved edits.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { FileEditorInput } from '../FileEditorInput.js'
import { MarkdownPreviewInput } from '../MarkdownPreviewInput.js'
import { openMarkdownPreviewInGroup } from '../openMarkdownPreview.js'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'

function makeFs(initial: Record<string, string>): IFileServiceType {
  const store = { ...initial }
  return {
    _serviceBrand: undefined,
    async readFile() {
      throw new Error('not implemented')
    },
    async readFileHead() {
      throw new Error('not implemented')
    },
    async readFileText(resource: URI) {
      const v = store[resource.toString()]
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    async writeFile(resource: URI, content: Uint8Array | string) {
      store[resource.toString()] =
        typeof content === 'string' ? content : new TextDecoder().decode(content)
    },
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not implemented')
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
  } as IFileServiceType
}

describe('openMarkdownPreviewInGroup', () => {
  const uriA = URI.file('/workspace/a.md')
  const uriB = URI.file('/workspace/b.md')
  let inst: InstantiationService
  let group: EditorGroupsService['activeGroup']

  beforeEach(() => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs({ [uriA.toString()]: 'original' }))
    inst = new InstantiationService(services)
    group = new EditorGroupsService().activeGroup
  })

  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  /** Mimic Ctrl+Shift+V: replace the source tab with a preview that adopts it. */
  async function openDirtySourceInTogglePreview(dirtyText?: string): Promise<FileEditorInput> {
    const source = inst.createInstance(FileEditorInput, uriA)
    const model = await source.resolveModel()
    if (dirtyText !== undefined) {
      model.setValue(dirtyText)
      source.updateDirtyFromModel(model)
    }
    group.openEditor(source, { activate: true, pinned: true })

    const preview = new MarkdownPreviewInput(source)
    group.openEditor(preview, { activate: true, pinned: true })
    group.detachEditor(source)
    preview.adoptSource()
    return source
  }

  it('keeps a dirty held source alive: re-attaches it as a tab instead of dropping its edits', async () => {
    const source = await openDirtySourceInTogglePreview('LOCAL EDITS')
    expect(source.isDirty).toBe(true)

    openMarkdownPreviewInGroup(group, new MarkdownPreviewInput(uriB), false)

    expect(source.isDisposed).toBe(false)
    expect(group.contains(source)).toBe(true)
    expect(source.isDirty).toBe(true)
    expect(MonacoModelRegistry.peek(uriA)?.getValue()).toBe('LOCAL EDITS')
    // The new preview took the old preview's slot; the source sits next to it.
    expect(group.activeEditor).toBeInstanceOf(MarkdownPreviewInput)
    expect(group.editors).toHaveLength(2)
    source.dispose()
  })

  it('disposes a clean held source with the preview (no extra tab)', async () => {
    const source = await openDirtySourceInTogglePreview()
    expect(source.isDirty).toBe(false)

    openMarkdownPreviewInGroup(group, new MarkdownPreviewInput(uriB), false)

    expect(source.isDisposed).toBe(true)
    expect(group.editors).toHaveLength(1)
    expect(group.activeEditor).toBeInstanceOf(MarkdownPreviewInput)
  })

  it('replaces a link-opened preview (no held source) in place', () => {
    const first = new MarkdownPreviewInput(uriA)
    group.openEditor(first, { activate: true, pinned: true })

    const second = new MarkdownPreviewInput(uriB)
    openMarkdownPreviewInGroup(group, second, false)

    expect(first.isDisposed).toBe(true)
    expect(group.editors).toHaveLength(1)
    expect(group.activeEditor).toBe(second)
  })

  it('opens an additional tab with toSide', () => {
    const first = new MarkdownPreviewInput(uriA)
    group.openEditor(first, { activate: true, pinned: true })

    const second = new MarkdownPreviewInput(uriB)
    openMarkdownPreviewInGroup(group, second, true)

    expect(first.isDisposed).toBe(false)
    expect(group.editors).toHaveLength(2)
    first.dispose()
  })
})
