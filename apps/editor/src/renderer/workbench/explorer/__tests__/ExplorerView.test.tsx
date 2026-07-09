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
  ILoggerService,
  INotificationService,
  IUndoRedoService,
  IWorkspaceService,
  ICommandService,
  InstantiationService,
  NullLogger,
  ServiceCollection,
  UndoRedoService,
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
import {
  ExplorerFileOperationService,
  IExplorerFileOperationService,
} from '../../../services/explorer/ExplorerFileOperationService.js'
import { ServicesContext } from '../../useService.js'
import { EditorResolverService } from '../../../services/editor/EditorResolverService.js'
import { IExcludeService } from '../../../services/exclude/ExcludeService.js'
import { FakeExcludeService } from '../../../services/exclude/testing/fakeExcludeService.js'

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
    async copy() {},
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
  services.set(IExcludeService, new FakeExcludeService())
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
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => new NullLogger(),
    setLevel: () => {},
    getLevel: () => 0,
  } as unknown as ILoggerService)
  const notification = { notify: () => ({ dispose() {} }) } as unknown as INotificationService
  services.set(INotificationService, notification)
  services.set(IUndoRedoService, new UndoRedoService(dialog, notification))
  const tree = inst.createInstance(ExplorerTreeService)
  services.set(IExplorerTreeService, tree)
  services.set(IExplorerFileOperationService, inst.createInstance(ExplorerFileOperationService))
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
    const { command } = renderView({ folder: null })
    expect(screen.getByText(/You have not yet opened a folder/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open Folder/i }))
    expect(command.calls.map((c) => c.id)).toContain('workbench.action.files.openFolder')
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
    expect(folderRow?.querySelector('[data-file-icon="mi-folder-src"]')).toBeTruthy()
    expect(fileRow?.querySelector('[data-file-icon="mi-readme"]')).toBeTruthy()
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

  it('right-clicking a row selects it (moving selection off the previously selected row)', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [
        { name: 'alpha.txt', isFile: true, isDirectory: false },
        { name: 'beta.txt', isFile: true, isDirectory: false },
      ],
    })
    renderView({ folder: root, fs })

    const alphaRow = (await screen.findByText('alpha.txt')).closest('[role="treeitem"]')!
    const betaRow = screen.getByText('beta.txt').closest('[role="treeitem"]')!

    fireEvent.click(alphaRow)
    await waitFor(() => expect(alphaRow.getAttribute('aria-selected')).toBe('true'))

    fireEvent.contextMenu(betaRow)
    await waitFor(() => expect(betaRow.getAttribute('aria-selected')).toBe('true'))
    expect(alphaRow.getAttribute('aria-selected')).toBe('false')
  })

  it('dragging an internal file onto the root moves it (rename), not copies it', async () => {
    const root = URI.file('/ws')
    const sub = URI.joinPath(root, 'src')
    const file = URI.joinPath(sub, 'a.ts')
    const renames: { from: string; to: string }[] = []
    const copies: { from: string; to: string }[] = []
    const fs = makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [sub.toString()]: [{ name: 'a.ts', isFile: true, isDirectory: false }],
    })
    fs.exists = async () => false
    fs.rename = async (from: URI, to: URI) => {
      renames.push({ from: from.toString(), to: to.toString() })
    }
    fs.copy = async (from: URI, to: URI) => {
      copies.push({ from: from.toString(), to: to.toString() })
    }

    renderView({ folder: root, fs })

    // Expand `src`, reveal `a.ts`
    fireEvent.click(await screen.findByText('src'))
    const fileLabel = await screen.findByText('a.ts')
    const fileRow = fileLabel.closest('[role="treeitem"]')!

    // Shared DataTransfer to carry the drag session across dragstart → drop.
    const dt = new DataTransfer()
    fireEvent.dragStart(fileRow, { dataTransfer: dt })

    const treeRoot = document.querySelector('[role="tree"]')!
    fireEvent.dragOver(treeRoot, { dataTransfer: dt })
    fireEvent.drop(treeRoot, { dataTransfer: dt })

    await waitFor(() => expect(renames).toHaveLength(1))
    expect(renames[0]).toEqual({ from: file.toString(), to: URI.joinPath(root, 'a.ts').toString() })
    expect(copies).toHaveLength(0)
  })
})
