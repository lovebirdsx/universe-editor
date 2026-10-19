/*---------------------------------------------------------------------------------------------
 *  Tests for RetargetEditorsOnRenameContribution — open file-backed tabs follow
 *  an Explorer rename/move without losing their slot, active state, dirty
 *  buffer or view state.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EditorGroupModel,
  Emitter,
  LogLevel,
  NullLogger,
  URI,
  UriIdentityService,
  type IEditorGroup,
  type IEditorGroupsService,
  type IFileService as IFileServiceType,
  type ILoggerService as ILoggerServiceType,
} from '@universe-editor/platform'

const liveModels = new Map<string, { getValue: () => string; isDisposed: () => boolean }>()
vi.mock('../../workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: {
    peek: (uri: { toString: () => string }) => liveModels.get(uri.toString()),
    onDidMarkModelClean: () => ({ dispose() {} }),
  },
}))

import { RetargetEditorsOnRenameContribution } from '../RetargetEditorsOnRenameContribution.js'
import type {
  ExplorerTreeService,
  IFileRenameOperation,
} from '../../services/explorer/ExplorerTreeService.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { EditorViewStateCache } from '../../services/editor/EditorViewStateCache.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { HtmlPreviewInput } from '../../services/editor/HtmlPreviewInput.js'
import { ImageEditorInput } from '../../services/editor/ImageEditorInput.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'

const disk = new Map<string, string>()
const fileService = {
  _serviceBrand: undefined,
  async readFileText(resource: URI) {
    return disk.get(resource.toString()) ?? ''
  },
  async stat() {
    throw new Error('ENOENT')
  },
} as unknown as IFileServiceType

class FakeExplorer {
  private readonly _emitter = new Emitter<readonly IFileRenameOperation[]>()
  readonly onDidRunFileOperation = this._emitter.event
  fire(ops: readonly IFileRenameOperation[]): void {
    this._emitter.fire(ops)
  }
}

const loggerService: ILoggerServiceType = {
  _serviceBrand: undefined,
  createLogger: () => new NullLogger(),
  setLevel: () => {},
  getLevel: () => LogLevel.Info,
}

function setup(...models: EditorGroupModel[]): {
  explorer: FakeExplorer
  contribution: RetargetEditorsOnRenameContribution
} {
  const explorer = new FakeExplorer()
  const groups = { groups: models as unknown as IEditorGroup[] } as unknown as IEditorGroupsService
  const contribution = new RetargetEditorsOnRenameContribution(
    explorer as unknown as ExplorerTreeService,
    groups,
    new UriIdentityService('linux'),
    loggerService,
  )
  return { explorer, contribution }
}

function renameOp(oldUri: URI, newUri: URI, isDirectory = false): IFileRenameOperation {
  return { oldUri, newUri, isDirectory }
}

afterEach(() => {
  liveModels.clear()
  disk.clear()
  EditorViewStateCache._resetForTests()
})

describe('RetargetEditorsOnRenameContribution', () => {
  it('moves a file tab to the new URI, preserving slot, active state and view state', () => {
    const oldUri = URI.file('/ws/a.txt')
    const newUri = URI.file('/ws/b.txt')
    const input = new FileEditorInput(oldUri, fileService)
    const other = new FileEditorInput(URI.file('/ws/c.txt'), fileService)
    const model = new EditorGroupModel()
    model.openEditor(input)
    model.openEditor(other)
    model.setActive(input)
    EditorViewStateCache.save(model.id, oldUri.toString(), { scrollTop: 42 })
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldUri, newUri)])

    expect(model.count).toBe(2)
    const moved = model.editors[0] as FileEditorInput
    expect(moved).not.toBe(input)
    expect(moved).toBeInstanceOf(FileEditorInput)
    expect(moved.resource.toString()).toBe(newUri.toString())
    expect(model.activeEditor).toBe(moved)
    expect(input.isDisposed).toBe(true)
    expect(EditorViewStateCache.load(model.id, newUri.toString())).toEqual({ scrollTop: 42 })
    expect(EditorViewStateCache.load(model.id, oldUri.toString())).toBeUndefined()
    contribution.dispose()
  })

  it('maps every resource under a renamed directory', () => {
    const oldDir = URI.file('/ws/dir')
    const newDir = URI.file('/ws/renamed')
    const oldUri = URI.file('/ws/dir/a.txt')
    const input = new FileEditorInput(oldUri, fileService)
    const model = new EditorGroupModel()
    model.openEditor(input)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldDir, newDir, true)])

    const moved = model.editors[0] as FileEditorInput
    expect(moved.resource.toString()).toBe(URI.file('/ws/renamed/a.txt').toString())
    contribution.dispose()
  })

  it('carries a dirty buffer into the replacement', async () => {
    const oldUri = URI.file('/ws/dirty.txt')
    const newUri = URI.file('/ws/dirty-renamed.txt')
    const input = new FileEditorInput(oldUri, fileService)
    liveModels.set(oldUri.toString(), { getValue: () => 'edited buffer', isDisposed: () => false })
    input.setDirty(true)
    const model = new EditorGroupModel()
    model.openEditor(input)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldUri, newUri)])

    const moved = model.editors[0] as FileEditorInput
    expect(moved.isDirty).toBe(true)
    await expect(moved.resolve()).resolves.toBe('edited buffer')
    contribution.dispose()
  })

  it('retargets image and markdown preview tabs', () => {
    const oldUri = URI.file('/ws/pic.png')
    const newUri = URI.file('/ws/renamed-pic.png')
    const image = new ImageEditorInput(oldUri)
    const preview = new MarkdownPreviewInput(oldUri)
    const model = new EditorGroupModel()
    model.openEditor(image)
    model.openEditor(preview)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldUri, newUri)])

    expect((model.editors[0] as ImageEditorInput).resource.toString()).toBe(newUri.toString())
    expect((model.editors[1] as MarkdownPreviewInput).sourceUri.toString()).toBe(newUri.toString())
    contribution.dispose()
  })

  it('rebuilds the held source input of a toggle-mode preview', () => {
    const oldUri = URI.file('/ws/doc.md')
    const newUri = URI.file('/ws/doc-renamed.md')
    const source = new FileEditorInput(oldUri, fileService)
    const preview = new MarkdownPreviewInput(source)
    preview.adoptSource()
    const model = new EditorGroupModel()
    model.openEditor(preview)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldUri, newUri)])

    const moved = model.editors[0] as MarkdownPreviewInput
    expect(moved).not.toBe(preview)
    expect(moved.sourceInput?.resource.toString()).toBe(newUri.toString())
    contribution.dispose()
  })

  it('retargets an HTML preview tab', () => {
    const oldUri = URI.file('/ws/page.html')
    const newUri = URI.file('/ws/page-renamed.html')
    const preview = new HtmlPreviewInput(oldUri)
    const model = new EditorGroupModel()
    model.openEditor(preview)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldUri, newUri)])

    const moved = model.editors[0] as HtmlPreviewInput
    expect(moved).not.toBe(preview)
    expect(moved.sourceUri.toString()).toBe(newUri.toString())
    contribution.dispose()
  })

  it('retargets both sides of a live diff and its cursor', () => {
    const oldUri = URI.file('/ws/live.txt')
    const newUri = URI.file('/ws/live-renamed.txt')
    const diff = new DiffEditorInput(
      oldUri,
      'head',
      'working',
      undefined,
      undefined,
      true,
      fileService,
    )
    liveModels.set(oldUri.toString(), { getValue: () => 'edited in diff', isDisposed: () => false })
    diff.setDirty(true)
    const model = new EditorGroupModel()
    model.openEditor(diff)
    EditorViewStateCache.save(model.id, diff.resource.toString(), { diffState: true })
    EditorViewStateCache.saveCursor(model.id, oldUri.toString(), { lineNumber: 3, column: 2 })
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldUri, newUri)])

    const moved = model.editors[0] as DiffEditorInput
    expect(moved.originalUri.toString()).toBe(newUri.toString())
    expect(moved.modifiedUri.toString()).toBe(newUri.toString())
    expect(moved.modifiedContent).toBe('edited in diff')
    expect(moved.isDirty).toBe(true)
    expect(EditorViewStateCache.load(model.id, moved.resource.toString())).toEqual({
      diffState: true,
    })
    expect(EditorViewStateCache.loadCursor(model.id, newUri.toString())).toEqual({
      lineNumber: 3,
      column: 2,
    })
    contribution.dispose()
  })

  it('keeps the cross-file diff cursor keyed by the unchanged original side', () => {
    const originalUri = URI.file('/ws/head.txt')
    const modifiedUri = URI.file('/ws/work.txt')
    const renamed = URI.file('/ws/work-renamed.txt')
    const diff = new DiffEditorInput(
      originalUri,
      'head',
      'working',
      modifiedUri,
      modifiedUri,
      true,
      fileService,
    )
    const model = new EditorGroupModel()
    model.openEditor(diff)
    EditorViewStateCache.saveCursor(model.id, originalUri.toString(), { lineNumber: 7, column: 4 })
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(modifiedUri, renamed)])

    const moved = model.editors[0] as DiffEditorInput
    expect(moved).not.toBe(diff)
    expect(moved.originalUri.toString()).toBe(originalUri.toString())
    expect(moved.modifiedUri.toString()).toBe(renamed.toString())
    expect(EditorViewStateCache.loadCursor(model.id, originalUri.toString())).toEqual({
      lineNumber: 7,
      column: 4,
    })
    expect(EditorViewStateCache.loadCursor(model.id, renamed.toString())).toBeUndefined()
    contribution.dispose()
  })

  it('updates a diff openable target in place when only that URI moved', () => {
    const originalUri = URI.file('/ws/head2.txt')
    const modifiedUri = URI.file('/ws/work2.txt')
    const openable = URI.file('/ws/source.txt')
    const renamed = URI.file('/ws/source-renamed.txt')
    const diff = new DiffEditorInput(
      originalUri,
      'head',
      'working',
      modifiedUri,
      openable,
      true,
      fileService,
    )
    const model = new EditorGroupModel()
    model.openEditor(diff)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(openable, renamed)])

    expect(model.editors[0]).toBe(diff)
    expect(diff.openableResource?.toString()).toBe(renamed.toString())
    contribution.dispose()
  })

  it('ignores a no-op operation whose old and new paths are equal', () => {
    const uri = URI.file('/ws/same.txt')
    const input = new FileEditorInput(uri, fileService)
    const model = new EditorGroupModel()
    model.openEditor(input)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(uri, uri)])

    expect(model.editors[0]).toBe(input)
    expect(input.isDisposed).toBe(false)
    contribution.dispose()
  })

  it('closes a clean stale tab when the replacement identity is already open', () => {
    const oldUri = URI.file('/ws/target.txt')
    const newUri = URI.file('/ws/taken.txt')
    const stale = new FileEditorInput(oldUri, fileService)
    const existing = new FileEditorInput(newUri, fileService)
    const model = new EditorGroupModel()
    model.openEditor(stale)
    model.openEditor(existing)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldUri, newUri)])

    expect(model.count).toBe(1)
    expect(model.editors[0]).toBe(existing)
    expect(stale.isDisposed).toBe(true)
    contribution.dispose()
  })

  it('keeps a dirty stale tab open when the replacement identity is already open', () => {
    const oldUri = URI.file('/ws/dirty-target.txt')
    const newUri = URI.file('/ws/dirty-taken.txt')
    const stale = new FileEditorInput(oldUri, fileService)
    const existing = new FileEditorInput(newUri, fileService)
    stale.setDirty(true)
    const model = new EditorGroupModel()
    model.openEditor(stale)
    model.openEditor(existing)
    const { explorer, contribution } = setup(model)

    explorer.fire([renameOp(oldUri, newUri)])

    expect(model.count).toBe(2)
    expect(model.editors[0]).toBe(stale)
    expect(stale.isDisposed).toBe(false)
    contribution.dispose()
  })

  it('replaces a shared input in every group without losing dirty state', () => {
    const oldUri = URI.file('/ws/shared.txt')
    const newUri = URI.file('/ws/shared-renamed.txt')
    const input = new FileEditorInput(oldUri, fileService)
    liveModels.set(oldUri.toString(), { getValue: () => 'shared dirty', isDisposed: () => false })
    input.setDirty(true)
    const left = new EditorGroupModel()
    const right = new EditorGroupModel()
    left.openEditor(input)
    right.openEditor(input)
    const { explorer, contribution } = setup(left, right)

    explorer.fire([renameOp(oldUri, newUri)])

    const leftMoved = left.editors[0] as FileEditorInput
    const rightMoved = right.editors[0] as FileEditorInput
    expect(leftMoved).not.toBe(input)
    expect(rightMoved).not.toBe(input)
    expect(leftMoved.resource.toString()).toBe(newUri.toString())
    expect(rightMoved.resource.toString()).toBe(newUri.toString())
    expect(leftMoved.isDirty).toBe(true)
    expect(rightMoved.isDirty).toBe(true)
    contribution.dispose()
  })
})
