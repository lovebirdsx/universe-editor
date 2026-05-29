/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/explorer/ExplorerView.tsx
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    async listRecursive() {
      return []
    },
  }
}

class FakeWorkspace implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace = new Emitter<IWorkspace | null>().event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()
  openFolderCalls = 0
  constructor(folder: URI | null) {
    this.current = folder ? { folder, name: 'ws' } : null
  }
  async openFolder() {
    this.openFolderCalls++
  }
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

class FakeEditor {
  declare readonly _serviceBrand: undefined
  opened: IEditorInput[] = []
  openEditors: IObservable<readonly IEditorInput[]> = observableValue<readonly IEditorInput[]>(
    'fake.openEditors',
    [],
  )
  activeEditorId = observableValue<string | undefined>('fake.activeId', undefined)
  activeEditor = observableValue<IEditorInput | undefined>('fake.active', undefined)
  openEditor(input: IEditorInput) {
    this.opened.push(input)
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

function renderView(opts: { folder: URI | null; fs?: IFileServiceType }) {
  const services = new ServiceCollection()
  const fs = opts.fs ?? makeFs()
  const ws = new FakeWorkspace(opts.folder)
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
  return { ...result, ws, editor, command, fs }
}

afterEach(() => cleanup())

describe('ExplorerView', () => {
  it('shows the empty state when there is no workspace', () => {
    const { ws } = renderView({ folder: null })
    expect(screen.getByText(/You have not yet opened a folder/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open Folder/i }))
    expect(ws.openFolderCalls).toBe(1)
  })

  it('renders root + children when a folder is open', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
    })
    renderView({ folder: root, fs })
    // initial load is async; let it settle
    await screen.findByText('README.md')
    expect(screen.getByText('src')).toBeTruthy()
  })

  it('renders themed file icons instead of emoji fallbacks', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
    })
    renderView({ folder: root, fs })

    const folderRow = (await screen.findByText('src')).closest('[role="treeitem"]')
    const fileRow = screen.getByText('README.md').closest('[role="treeitem"]')

    expect(screen.queryByText('📁')).toBeFalsy()
    expect(screen.queryByText('📄')).toBeFalsy()
    expect(folderRow?.querySelector('[data-file-icon="folder-src"]')).toBeTruthy()
    expect(fileRow?.querySelector('[data-file-icon="file-readme"]')).toBeTruthy()
  })

  it('clicking a file opens it through IEditorService', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [{ name: 'README.md', isFile: true, isDirectory: false }],
    })
    const { editor } = renderView({ folder: root, fs })
    fireEvent.click(await screen.findByText('README.md'))
    await waitFor(() => expect(editor.opened).toHaveLength(1))
    expect(editor.opened[0]?.type ?? (editor.opened[0] as { typeId?: string }).typeId).toBe('file')
  })
})
