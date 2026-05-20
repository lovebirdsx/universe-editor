/*---------------------------------------------------------------------------------------------
 *  Tests for ExplorerView — keyboard navigation (up/down/left/right/Enter/Home/End/F2/Delete).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  IDialogService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  IFileWatcherService,
  IWorkspaceService,
  ICommandService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
  type IDirectoryEntry,
  type IEditorInput,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type IObservable,
  type IOpenEditorServiceOptions,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ExplorerView } from '../ExplorerView.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from '../../../services/explorer/ExplorerTreeService.js'
import { ServicesContext } from '../../useService.js'
import { EditorResolverService } from '../../../services/editor/EditorResolverService.js'

function makeFs(initial: Record<string, IDirectoryEntry[]> = {}): IFileServiceType {
  const dirs = new Map(Object.entries(initial))
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
    async list(resource: URI) {
      return dirs.get(resource.toString()) ?? []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  }
}

class FakeWorkspace implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace = new Emitter<IWorkspace | null>().event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  constructor(folder: URI | null) {
    this.current = folder ? { folder, name: 'ws' } : null
  }
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
}

class FakeEditor {
  declare readonly _serviceBrand: undefined
  opened: Array<{ input: IEditorInput; options: IOpenEditorServiceOptions | undefined }> = []
  openEditors: IObservable<readonly IEditorInput[]> = observableValue<readonly IEditorInput[]>(
    'fake.openEditors',
    [],
  )
  activeEditorId = observableValue<string | undefined>('fake.activeId', undefined)
  activeEditor = observableValue<IEditorInput | undefined>('fake.active', undefined)
  openEditor(input: IEditorInput, options?: IOpenEditorServiceOptions) {
    this.opened.push({ input, options })
  }
  closeEditor() {}
  closeAllEditors() {}
}

class FakeCommand {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{ id: string; args: unknown }> = []
  registerCommand() {
    return { dispose() {} }
  }
  async executeCommand(id: string, args: unknown) {
    this.calls.push({ id, args })
  }
}

function makeNoopWatcher(): IFileWatcherServiceType {
  return {
    _serviceBrand: undefined,
    onDidChangeFiles: new Emitter<readonly never[]>().event,
    async watch() {},
    async unwatch() {},
  } as unknown as IFileWatcherServiceType
}

function renderView(folder: URI, fs: IFileServiceType) {
  const services = new ServiceCollection()
  const ws = new FakeWorkspace(folder)
  const editor = new FakeEditor()
  const command = new FakeCommand()
  const dialog: IDialogServiceType = {
    _serviceBrand: undefined,
    confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
    prompt: async () => undefined,
  }
  services.set(IFileService, fs)
  services.set(IFileWatcherService, makeNoopWatcher())
  services.set(IWorkspaceService, ws)
  services.set(IEditorService, editor as unknown as IEditorService)
  services.set(ICommandService, command as unknown as ICommandService)
  services.set(IDialogService, dialog)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get<T>(_key: string, defaultValue?: T): T | undefined {
      return defaultValue
    },
    update() {},
    loadLayer() {},
    onDidChangeConfiguration: new Emitter<never>().event,
  } as unknown as IConfigurationService)
  const inst = new InstantiationService(services)
  const editorResolver = inst.createInstance(EditorResolverService)
  services.set(IEditorResolverService, editorResolver)
  const tree = inst.createInstance(ExplorerTreeService)
  services.set(IExplorerTreeService, tree)
  const result = render(
    <ServicesContext.Provider value={inst}>
      <ExplorerView />
    </ServicesContext.Provider>,
  )
  return { ...result, editor, command, tree }
}

function getViewEl(): HTMLElement {
  // The outer view container is the closest [role="tree"] ancestor of any row.
  const el = document.querySelector('[role="tree"]')
  if (!el) throw new Error('explorer view root not rendered')
  return el as HTMLElement
}

afterEach(() => cleanup())

describe('ExplorerView — keyboard navigation', () => {
  it('ArrowDown / ArrowUp move the selection through visible rows', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [
        { name: 'a.txt', isFile: true, isDirectory: false },
        { name: 'b.txt', isFile: true, isDirectory: false },
      ],
    })
    const { tree } = renderView(root, fs)
    await screen.findByText('a.txt')

    const view = getViewEl()
    // First ArrowDown lands on the root row (index 0).
    fireEvent.keyDown(view, { key: 'ArrowDown' })
    await waitFor(() => expect(tree.selectedResource?.toString()).toBe(root.toString()))

    fireEvent.keyDown(view, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(tree.selectedResource?.toString()).toBe(URI.joinPath(root, 'a.txt').toString()),
    )

    fireEvent.keyDown(view, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(tree.selectedResource?.toString()).toBe(URI.joinPath(root, 'b.txt').toString()),
    )

    fireEvent.keyDown(view, { key: 'ArrowUp' })
    await waitFor(() =>
      expect(tree.selectedResource?.toString()).toBe(URI.joinPath(root, 'a.txt').toString()),
    )
  })

  it('ArrowRight expands a collapsed directory; second press jumps into the first child', async () => {
    const root = URI.file('/ws')
    const src = URI.joinPath(root, 'src')
    const fs = makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [src.toString()]: [{ name: 'main.ts', isFile: true, isDirectory: false }],
    })
    const { tree } = renderView(root, fs)
    await screen.findByText('src')

    // Select the src folder.
    await act(async () => {
      await tree.reveal(src)
    })
    // Collapse it first (reveal may have expanded ancestors but src itself
    // wasn't expanded by reveal). Ensure starting state is collapsed.
    tree.collapse(src)

    const view = getViewEl()
    fireEvent.keyDown(view, { key: 'ArrowRight' })
    await waitFor(() => expect(tree.isExpanded(src)).toBe(true))
    await screen.findByText('main.ts')

    fireEvent.keyDown(view, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(tree.selectedResource?.toString()).toBe(URI.joinPath(src, 'main.ts').toString()),
    )
  })

  it('ArrowLeft collapses an expanded directory; from a leaf it jumps to its parent', async () => {
    const root = URI.file('/ws')
    const src = URI.joinPath(root, 'src')
    const main = URI.joinPath(src, 'main.ts')
    const fs = makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [src.toString()]: [{ name: 'main.ts', isFile: true, isDirectory: false }],
    })
    const { tree } = renderView(root, fs)
    await screen.findByText('src')
    await act(async () => {
      await tree.reveal(main)
    })

    const view = getViewEl()
    fireEvent.keyDown(view, { key: 'ArrowLeft' })
    await waitFor(() => expect(tree.selectedResource?.toString()).toBe(src.toString()))

    // src is expanded → ArrowLeft now collapses it.
    fireEvent.keyDown(view, { key: 'ArrowLeft' })
    await waitFor(() => expect(tree.isExpanded(src)).toBe(false))
  })

  it('Enter on a file opens it pinned; Space opens it as preview', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [{ name: 'README.md', isFile: true, isDirectory: false }],
    })
    const { editor, tree } = renderView(root, fs)
    await screen.findByText('README.md')
    const readme = URI.joinPath(root, 'README.md')
    await act(async () => {
      await tree.reveal(readme)
    })

    const view = getViewEl()
    fireEvent.keyDown(view, { key: 'Enter' })
    await waitFor(() => expect(editor.opened).toHaveLength(1))
    expect(editor.opened[0]?.options?.pinned).toBe(true)

    fireEvent.keyDown(view, { key: ' ' })
    await waitFor(() => expect(editor.opened).toHaveLength(2))
    expect(editor.opened[1]?.options?.pinned).toBe(false)
  })

  it('Home jumps to the first row; End jumps to the last', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [
        { name: 'a.txt', isFile: true, isDirectory: false },
        { name: 'b.txt', isFile: true, isDirectory: false },
      ],
    })
    const { tree } = renderView(root, fs)
    await screen.findByText('b.txt')

    const view = getViewEl()
    fireEvent.keyDown(view, { key: 'End' })
    await waitFor(() =>
      expect(tree.selectedResource?.toString()).toBe(URI.joinPath(root, 'b.txt').toString()),
    )

    fireEvent.keyDown(view, { key: 'Home' })
    await waitFor(() => expect(tree.selectedResource?.toString()).toBe(root.toString()))
  })

  it('F2 dispatches the rename command for the selected file', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [{ name: 'a.txt', isFile: true, isDirectory: false }],
    })
    const { command, tree } = renderView(root, fs)
    await screen.findByText('a.txt')
    const a = URI.joinPath(root, 'a.txt')
    await act(async () => {
      await tree.reveal(a)
    })

    fireEvent.keyDown(getViewEl(), { key: 'F2' })
    expect(command.calls).toHaveLength(1)
    expect(command.calls[0]?.id).toBe('workbench.files.action.rename')
    expect((command.calls[0]?.args as { target: URI }).target.toString()).toBe(a.toString())
  })

  it('Delete dispatches the delete command for the selected entry', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [{ name: 'a.txt', isFile: true, isDirectory: false }],
    })
    const { command, tree } = renderView(root, fs)
    await screen.findByText('a.txt')
    const a = URI.joinPath(root, 'a.txt')
    await act(async () => {
      await tree.reveal(a)
    })

    fireEvent.keyDown(getViewEl(), { key: 'Delete' })
    expect(command.calls).toHaveLength(1)
    expect(command.calls[0]?.id).toBe('workbench.files.action.delete')
  })
})
