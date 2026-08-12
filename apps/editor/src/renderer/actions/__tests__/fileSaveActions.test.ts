/**
 * Save-As writes the picked file and replaces the editor; the extension host
 * must then hear a did-save for the new file URI (VSCode parity for untitled
 * buffers gaining a file identity, and for file Save-As). The notification is
 * fired after the write and the editor swap; DidSaveNotificationContribution
 * holds it until the mirror's open push has landed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstantiationService,
  ServiceCollection,
  URI,
  IEditorGroupsService,
  IFileDialogService,
  IFileService,
  IWorkspaceService,
  type EditorInput,
} from '@universe-editor/platform'
import { SaveFileAsAction } from '../fileSaveActions.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { UntitledEditorInput } from '../../services/editor/UntitledEditorInput.js'
import { DidSaveNotification } from '../../services/extensions/DidSaveNotification.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'

const PICKED = URI.file('/ws/notes/saved.txt')

class FakeEditorGroup {
  activeEditor: EditorInput | undefined
  readonly editors: EditorInput[] = []

  openEditor(editor: EditorInput): void {
    this.editors.push(editor)
    this.activeEditor = editor
  }

  closeEditor(editor: EditorInput): void {
    const index = this.editors.indexOf(editor)
    if (index >= 0) this.editors.splice(index, 1)
  }
}

describe('SaveFileAsAction', () => {
  const disposables: Array<{ dispose(): void }> = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function setup(active: EditorInput) {
    const group = new FakeEditorGroup()
    group.editors.push(active)
    group.activeEditor = active
    const groups = {
      activeGroup: group,
      activeGroupForOpen: group,
      groups: [group],
      getGroups: () => [group],
      activateGroup: () => undefined,
    } as unknown as IEditorGroupsService
    const showSaveDialog = vi.fn().mockResolvedValue(PICKED)
    const fileDialog = { showSaveDialog } as unknown as IFileDialogService
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const fileService = { writeFile } as unknown as IFileService
    const workspace = {
      current: { folder: URI.file('/ws'), name: 'ws' },
    } as unknown as IWorkspaceService

    const services = new ServiceCollection()
    services.set(IEditorGroupsService, groups)
    services.set(IFileDialogService, fileDialog)
    services.set(IFileService, fileService)
    services.set(IWorkspaceService, workspace)
    return { group, showSaveDialog, writeFile, inst: new InstantiationService(services) }
  }

  it('untitled Save-As writes the picked file and notifies did-save with the new URI', async () => {
    const untitled = new UntitledEditorInput()
    disposables.push(untitled)
    const { group, writeFile, inst } = setup(untitled)
    const order: string[] = []
    writeFile.mockImplementation(async () => {
      order.push('write')
    })
    const notified: URI[] = []
    disposables.push(
      DidSaveNotification.register((uri) => {
        order.push('notify')
        notified.push(uri)
      }),
    )

    await inst.invokeFunction((accessor) => new SaveFileAsAction().run(accessor))

    expect(writeFile).toHaveBeenCalledWith(PICKED, '')
    expect(notified).toEqual([PICKED])
    // The save notification is only meaningful once the write has landed.
    expect(order).toEqual(['write', 'notify'])

    // The untitled tab is replaced by a file editor bound to the picked URI.
    expect(group.editors).toHaveLength(1)
    const replacement = group.editors[0]!
    disposables.push(replacement)
    expect(replacement).toBeInstanceOf(FileEditorInput)
    expect(replacement.resource?.toString()).toBe(PICKED.toString())
    expect(group.editors).not.toContain(untitled)
  })

  it('untitled Save-As force-disposes the dead untitled model so its mirror closes', async () => {
    const untitled = new UntitledEditorInput()
    disposables.push(untitled)
    const { writeFile, inst } = setup(untitled)
    const forceDispose = vi.spyOn(MonacoModelRegistry, 'forceDispose')
    disposables.push({ dispose: () => forceDispose.mockRestore() })

    await inst.invokeFunction((accessor) => new SaveFileAsAction().run(accessor))

    expect(writeFile).toHaveBeenCalled()
    // The untitled buffer's identity ends at Save-As: its model must be disposed
    // (not merely released) so `$acceptDocumentClose(untitled)` reaches the host.
    expect(forceDispose).toHaveBeenCalledWith(untitled.resource)
  })

  it('does not notify when the save dialog is cancelled', async () => {
    const untitled = new UntitledEditorInput()
    disposables.push(untitled)
    const { showSaveDialog, writeFile, inst } = setup(untitled)
    showSaveDialog.mockResolvedValue(undefined)
    const notified: URI[] = []
    disposables.push(DidSaveNotification.register((uri) => notified.push(uri)))

    await inst.invokeFunction((accessor) => new SaveFileAsAction().run(accessor))

    expect(writeFile).not.toHaveBeenCalled()
    expect(notified).toEqual([])
  })

  it('file Save-As keeps the source model alive (no force-dispose)', async () => {
    const fileService = { readFileText: vi.fn().mockResolvedValue('file text') }
    const file = new FileEditorInput(URI.file('/ws/a.txt'), fileService as unknown as IFileService)
    disposables.push(file)
    const { inst } = setup(file)
    const forceDispose = vi.spyOn(MonacoModelRegistry, 'forceDispose')
    disposables.push({ dispose: () => forceDispose.mockRestore() })

    await inst.invokeFunction((accessor) => new SaveFileAsAction().run(accessor))

    // A file document keeps its on-disk identity after Save-As — only the
    // untitled buffer (whose identity is gone) is force-disposed.
    expect(forceDispose).not.toHaveBeenCalled()
  })
})
