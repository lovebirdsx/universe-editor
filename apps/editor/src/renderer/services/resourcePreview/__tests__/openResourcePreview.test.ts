/*---------------------------------------------------------------------------------------------
 *  Tests for openResourcePreviewInGroup — the hover "Open Preview" button every
 *  file list shares. Both flavors route through openPreviewInGroup, so a group
 *  keeps at most one preview per kind and a *dirty* held source survives the
 *  retarget (the html branch used to hand-roll this and dropped that guard).
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { HtmlPreviewInput } from '../../editor/HtmlPreviewInput.js'
import { MarkdownPreviewInput } from '../../editor/MarkdownPreviewInput.js'
import { openResourcePreviewInGroup } from '../openResourcePreview.js'

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

describe('openResourcePreviewInGroup', () => {
  let inst: InstantiationService
  let group: EditorGroupsService['activeGroup']

  beforeEach(() => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFakeFileService())
    inst = new InstantiationService(services)
    group = new EditorGroupsService().activeGroup
  })

  /** Mimic Ctrl+Shift+V: a preview holding the (detached) source tab it replaced. */
  function togglePreview(
    kind: 'markdown' | 'html',
    uri: URI,
    dirty: boolean,
  ): { preview: MarkdownPreviewInput | HtmlPreviewInput; source: FileEditorInput } {
    const source = inst.createInstance(FileEditorInput, uri)
    source.setDirty(dirty)
    group.openEditor(source, { activate: true, pinned: true })
    const preview =
      kind === 'markdown' ? new MarkdownPreviewInput(source) : new HtmlPreviewInput(source)
    group.openEditor(preview, { activate: true, pinned: true })
    group.detachEditor(source)
    preview.adoptSource()
    return { preview, source }
  }

  it('retargets a markdown preview when the active editor is a file', () => {
    const previewA = new MarkdownPreviewInput(URI.file('/repo/a.md'))
    group.openEditor(previewA, { activate: true, pinned: true })
    const sourceB = inst.createInstance(FileEditorInput, URI.file('/repo/b.md'))
    group.openEditor(sourceB, { activate: true, pinned: true })

    expect(openResourcePreviewInGroup(group, URI.file('/repo/c.md'), false)).toBe(true)

    expect(previewA.isDisposed).toBe(true)
    expect(group.editors).toHaveLength(2)
    expect(group.activeEditor).toBeInstanceOf(MarkdownPreviewInput)
    expect(group.editors[1]).toBe(sourceB)
  })

  it('retargets an html preview and re-attaches its dirty held source', () => {
    const { preview, source } = togglePreview('html', URI.file('/repo/a.html'), true)

    expect(openResourcePreviewInGroup(group, URI.file('/repo/b.html'), false)).toBe(true)

    expect(preview.isDisposed).toBe(true)
    // The dirty source came back as a tab instead of being cascade-disposed.
    expect(source.isDisposed).toBe(false)
    expect(group.contains(source)).toBe(true)
    expect(group.editors).toHaveLength(2)
    expect(group.activeEditor).toBeInstanceOf(HtmlPreviewInput)
    source.dispose()
  })

  it('disposes a dirty held html source when the group already shows that file', () => {
    const uri = URI.file('/repo/a.html')
    const { source } = togglePreview('html', uri, true)
    const reopened = inst.createInstance(FileEditorInput, uri)
    group.openEditor(reopened, { activate: false, pinned: true })

    expect(openResourcePreviewInGroup(group, URI.file('/repo/b.html'), false)).toBe(true)

    // No duplicate tab for a.html: the held input is dropped, the open one stays
    // and takes over its dirty flag so the unsaved edits keep their close prompt.
    expect(source.isDisposed).toBe(true)
    expect(reopened.isDisposed).toBe(false)
    expect(reopened.isDirty).toBe(true)
    expect(group.editors).toHaveLength(2)
    expect(group.editors[1]).toBe(reopened)
  })

  it('adds a second preview tab with toSide', () => {
    const previewA = new MarkdownPreviewInput(URI.file('/repo/a.md'))
    group.openEditor(previewA, { activate: true, pinned: true })

    expect(openResourcePreviewInGroup(group, URI.file('/repo/b.md'), true)).toBe(true)

    expect(previewA.isDisposed).toBe(false)
    expect(group.editors).toHaveLength(2)
    previewA.dispose()
  })

  it('returns false for a resource with no preview flavor', () => {
    expect(openResourcePreviewInGroup(group, URI.file('/repo/main.ts'), false)).toBe(false)
    expect(group.editors).toHaveLength(0)
  })
})
