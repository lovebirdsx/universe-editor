/*---------------------------------------------------------------------------------------------
 *  Tests for openPreviewInGroup — a preview of a given file is globally unique
 *  (opening it while another group shows it focuses that tab instead of opening
 *  a second one), previews of different files coexist in one group, and a
 *  toggle preview inherits the source tab's pin state.
 *
 *  Regression guard: a toggle-mode preview holds its source FileEditorInput
 *  (detached, not disposed) so the Monaco model survives the toggle. Replacing
 *  a clean toggle preview via the preview slot must cascade-dispose that held
 *  source (no leak); a *dirty* held source must survive — a previewReplace
 *  would release the shared model and silently drop unsaved edits.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GroupDirection,
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
import { openPreviewInGroup, togglePreviewInGroup } from '../openPreviewInGroup.js'
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
  let groups: EditorGroupsService
  let group: EditorGroupsService['activeGroup']
  let side: EditorGroupsService['activeGroup']

  beforeEach(() => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs({ [uriA.toString()]: 'original' }))
    inst = new InstantiationService(services)
    groups = new EditorGroupsService()
    group = groups.activeGroup
    side = groups.addGroup(group, GroupDirection.Right)
  })

  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  /** A source sitting in the group's preview slot with unsaved model edits. */
  async function openDirtySourceInSlot(dirtyText: string): Promise<FileEditorInput> {
    const source = inst.createInstance(FileEditorInput, uriA)
    const model = await source.resolveModel()
    model.setValue(dirtyText)
    source.updateDirtyFromModel(model)
    group.openEditor(source, { activate: true, pinned: false })
    return source
  }

  it('activates the existing preview for the same file instead of adding a tab', () => {
    const first = new MarkdownPreviewInput(uriA)
    group.openEditor(first, { activate: true, pinned: true })
    const sourceB = inst.createInstance(FileEditorInput, uriB)
    group.openEditor(sourceB, { activate: true, pinned: true })

    const duplicate = new MarkdownPreviewInput(uriA)
    openPreviewInGroup(groups, group, duplicate)

    expect(group.activeEditor).toBe(first)
    expect(group.editors).toHaveLength(2)
    // The speculative input must not linger as a parentless disposable.
    expect(duplicate.isDisposed).toBe(true)
    expect(first.isDisposed).toBe(false)
  })

  it('focuses the existing preview in another group instead of opening a duplicate', () => {
    const existing = new MarkdownPreviewInput(uriA)
    side.openEditor(existing, { activate: true, pinned: true })
    groups.activateGroup(group)

    const duplicate = new MarkdownPreviewInput(uriA)
    openPreviewInGroup(groups, group, duplicate)

    expect(groups.activeGroup).toBe(side)
    expect(side.activeEditor).toBe(existing)
    expect(duplicate.isDisposed).toBe(true)
    expect(existing.isDisposed).toBe(false)
    expect(group.editors).toHaveLength(0)
  })

  it('lets previews of different files coexist in the same group', () => {
    const a = new MarkdownPreviewInput(uriA)
    openPreviewInGroup(groups, group, a)
    const b = new MarkdownPreviewInput(uriB)
    openPreviewInGroup(groups, group, b)

    expect(group.editors).toHaveLength(2)
    expect(a.isDisposed).toBe(false)
    expect(group.activeEditor).toBe(b)
  })

  it('leaves a preview of another kind alone', () => {
    const html = new HtmlPreviewInput(URI.file('/workspace/page.html'))
    group.openEditor(html, { activate: true, pinned: true })

    const markdown = new MarkdownPreviewInput(uriA)
    openPreviewInGroup(groups, group, markdown)

    expect(html.isDisposed).toBe(false)
    expect(group.editors).toEqual([html, markdown])
  })

  it('toggle: a pinned source yields a pinned preview that holds the source', () => {
    const source = inst.createInstance(FileEditorInput, uriA)
    group.openEditor(source, { activate: true, pinned: true })

    const preview = new MarkdownPreviewInput(source)
    togglePreviewInGroup(groups, group, preview, source)

    expect(group.isPinned(preview)).toBe(true)
    expect(group.contains(source)).toBe(false)
    expect(preview.sourceInput).toBe(source)
    expect(source.isDisposed).toBe(false)
    expect(group.editors).toEqual([preview])
  })

  it('toggle: a preview-slot source yields a preview in the slot, without disposing the source', () => {
    const source = inst.createInstance(FileEditorInput, uriA)
    group.openEditor(source, { activate: true, pinned: false })

    const preview = new MarkdownPreviewInput(source)
    togglePreviewInGroup(groups, group, preview, source)

    expect(group.isPinned(preview)).toBe(false)
    expect(group.previewEditor).toBe(preview)
    expect(source.isDisposed).toBe(false)
    expect(group.editors).toEqual([preview])
  })

  it('toggle: a dirty source forces the preview pinned even when the source sits in the slot', async () => {
    const source = await openDirtySourceInSlot('LOCAL EDITS')
    expect(source.isDirty).toBe(true)

    const preview = new MarkdownPreviewInput(source)
    togglePreviewInGroup(groups, group, preview, source)

    expect(group.isPinned(preview)).toBe(true)
    expect(preview.sourceInput).toBe(source)
    expect(source.isDisposed).toBe(false)
  })

  it('toggle pins a dirty source so a later slot open cannot evict it', async () => {
    const source = await openDirtySourceInSlot('LOCAL EDITS')
    const preview = new MarkdownPreviewInput(source)
    togglePreviewInGroup(groups, group, preview, source)

    const other = inst.createInstance(FileEditorInput, uriB)
    group.openEditor(other, { activate: true, pinned: false })

    // The pinned preview stays; the new file takes the slot next to it.
    expect(group.editors).toEqual([preview, other])
    expect(group.previewEditor).toBe(other)
    expect(preview.isDisposed).toBe(false)
    expect(source.isDisposed).toBe(false)
    expect(MonacoModelRegistry.peek(uriA)?.getValue()).toBe('LOCAL EDITS')
  })

  it('replacing a clean toggle preview in the slot cascade-disposes its held source (no leak)', () => {
    const source = inst.createInstance(FileEditorInput, uriA)
    group.openEditor(source, { activate: true, pinned: false })
    const preview = new MarkdownPreviewInput(source)
    togglePreviewInGroup(groups, group, preview, source)

    const other = inst.createInstance(FileEditorInput, uriB)
    group.openEditor(other, { activate: true, pinned: false })

    expect(preview.isDisposed).toBe(true)
    expect(source.isDisposed).toBe(true)
    expect(group.editors).toEqual([other])
    expect(group.previewEditor).toBe(other)
  })

  it('toggle focuses a preview already open in another group and leaves the source alone', () => {
    const source = inst.createInstance(FileEditorInput, uriA)
    group.openEditor(source, { activate: true, pinned: true })
    const existingPreview = new MarkdownPreviewInput(uriA)
    side.openEditor(existingPreview, { activate: true, pinned: true })
    groups.activateGroup(group)

    const spec = new MarkdownPreviewInput(source)
    togglePreviewInGroup(groups, group, spec, source)

    expect(groups.activeGroup).toBe(side)
    expect(side.activeEditor).toBe(existingPreview)
    expect(spec.isDisposed).toBe(true)
    expect(existingPreview.isDisposed).toBe(false)
    expect(group.contains(source)).toBe(true)
    expect(source.isDisposed).toBe(false)
  })

  it('toggle lands the preview at the source tab position among other tabs', () => {
    const source = inst.createInstance(FileEditorInput, uriA)
    const before = inst.createInstance(FileEditorInput, uriB)
    const after = inst.createInstance(FileEditorInput, uriC)
    group.openEditor(before, { activate: false, pinned: true })
    group.openEditor(source, { activate: true, pinned: true })
    group.openEditor(after, { activate: false, pinned: true })

    const preview = new MarkdownPreviewInput(source)
    togglePreviewInGroup(groups, group, preview, source)

    expect(group.editors).toEqual([before, preview, after])
    expect(group.activeEditor).toBe(preview)
  })

  it('opening into a non-active group activates it (reopen / lock-routed paths stay visible)', () => {
    groups.activateGroup(group)
    const preview = new MarkdownPreviewInput(uriA)
    openPreviewInGroup(groups, side, preview)

    expect(side.contains(preview)).toBe(true)
    expect(groups.activeGroup).toBe(side)
    expect(side.activeEditor).toBe(preview)
  })
})
