/*---------------------------------------------------------------------------------------------
 *  Tests for openPreviewInGroup — a group holds at most one rendered preview per
 *  kind, so opening another file's preview retargets the existing tab in place
 *  (VSCode's dynamic preview) instead of piling up tabs.
 *
 *  Regression guard: a toggle-mode preview holds its source FileEditorInput
 *  (detached, not disposed) so the Monaco model survives the toggle. Retargeting
 *  such a preview must not cascade-dispose a *dirty* source — that would release
 *  the shared model and silently drop unsaved edits.
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
import { HtmlPreviewInput } from '../HtmlPreviewInput.js'
import { MarkdownPreviewInput } from '../MarkdownPreviewInput.js'
import { openPreviewInGroup } from '../openPreviewInGroup.js'
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

describe('openPreviewInGroup', () => {
  const uriA = URI.file('/workspace/a.md')
  const uriB = URI.file('/workspace/b.md')
  const uriC = URI.file('/workspace/c.md')
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

    openPreviewInGroup(group, new MarkdownPreviewInput(uriB), false)

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

    openPreviewInGroup(group, new MarkdownPreviewInput(uriB), false)

    expect(source.isDisposed).toBe(true)
    expect(group.editors).toHaveLength(1)
    expect(group.activeEditor).toBeInstanceOf(MarkdownPreviewInput)
  })

  it('replaces a link-opened preview (no held source) in place', () => {
    const first = new MarkdownPreviewInput(uriA)
    group.openEditor(first, { activate: true, pinned: true })

    const second = new MarkdownPreviewInput(uriB)
    openPreviewInGroup(group, second, false)

    expect(first.isDisposed).toBe(true)
    expect(group.editors).toHaveLength(1)
    expect(group.activeEditor).toBe(second)
  })

  it('opens an additional tab with toSide', () => {
    const first = new MarkdownPreviewInput(uriA)
    group.openEditor(first, { activate: true, pinned: true })

    const second = new MarkdownPreviewInput(uriB)
    openPreviewInGroup(group, second, true)

    expect(first.isDisposed).toBe(false)
    expect(group.editors).toHaveLength(2)
    first.dispose()
  })

  it('retargets an inactive preview tab when the active editor is a file', () => {
    const first = new MarkdownPreviewInput(uriA)
    group.openEditor(first, { activate: true, pinned: true })
    const sourceB = inst.createInstance(FileEditorInput, uriB)
    group.openEditor(sourceB, { activate: true, pinned: true })

    const second = new MarkdownPreviewInput(uriC)
    openPreviewInGroup(group, second, false)

    // The preview took a.md's preview slot rather than becoming a third tab.
    expect(first.isDisposed).toBe(true)
    expect(group.editors).toEqual([second, sourceB])
    expect(group.activeEditor).toBe(second)
  })

  it('retargets the active preview rather than an earlier one in the group', () => {
    const first = new MarkdownPreviewInput(uriA)
    group.openEditor(first, { activate: true, pinned: true })
    const second = new MarkdownPreviewInput(uriB)
    group.openEditor(second, { activate: true, pinned: true })

    const third = new MarkdownPreviewInput(uriC)
    openPreviewInGroup(group, third, false)

    expect(second.isDisposed).toBe(true)
    expect(first.isDisposed).toBe(false)
    expect(group.editors).toEqual([first, third])
    first.dispose()
  })

  it('leaves a preview of another kind alone', () => {
    const html = new HtmlPreviewInput(URI.file('/workspace/page.html'))
    group.openEditor(html, { activate: true, pinned: true })

    const markdown = new MarkdownPreviewInput(uriA)
    openPreviewInGroup(group, markdown, false)

    expect(html.isDisposed).toBe(false)
    expect(group.editors).toEqual([html, markdown])
    html.dispose()
  })

  it('disposes a dirty held source when the group already shows that file', async () => {
    const held = await openDirtySourceInTogglePreview('LOCAL EDITS')
    // A second tab for a.md, as if the user reopened the source alongside the
    // preview — the held input must not become a duplicate tab.
    const reopened = inst.createInstance(FileEditorInput, uriA)
    await reopened.resolveModel()
    group.openEditor(reopened, { activate: false, pinned: true })
    // It resolved the shared model *after* the edits landed, so it starts clean.
    expect(reopened.isDirty).toBe(false)

    openPreviewInGroup(group, new MarkdownPreviewInput(uriB), false)

    expect(held.isDisposed).toBe(true)
    expect(reopened.isDisposed).toBe(false)
    // The surviving tab inherits the dirty flag, or closing it would neither
    // prompt nor back up the unsaved edits sitting in the shared model.
    expect(reopened.isDirty).toBe(true)
    expect(MonacoModelRegistry.peek(uriA)?.getValue()).toBe('LOCAL EDITS')
    expect(group.editors).toEqual([group.activeEditor, reopened])
    expect(group.editors).toHaveLength(2)
  })

  it('reactivates the existing preview for the same file instead of adding a tab', () => {
    const first = new MarkdownPreviewInput(uriA)
    group.openEditor(first, { activate: true, pinned: true })
    const sourceB = inst.createInstance(FileEditorInput, uriB)
    group.openEditor(sourceB, { activate: true, pinned: true })

    const duplicate = new MarkdownPreviewInput(uriA)
    openPreviewInGroup(group, duplicate, false)

    expect(group.activeEditor).toBe(first)
    expect(group.editors).toHaveLength(2)
    // The speculative input must not linger as a parentless disposable.
    expect(duplicate.isDisposed).toBe(true)
    expect(first.isDisposed).toBe(false)
  })
})
