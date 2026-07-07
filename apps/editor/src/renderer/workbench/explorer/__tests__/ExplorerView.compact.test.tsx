/*---------------------------------------------------------------------------------------------
 *  Compact-folder tests for ExplorerView:
 *  1. Label shows merged compact path.
 *  2. Drag source (dragHandleProps) exposes compactRoot, not the leaf URI.
 *  3. Drop target still resolves to the leaf (innermost dir of the compact chain).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import {
  Emitter,
  CommandsRegistry,
  IConfigurationService,
  ICommandService,
  IDialogService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  INotificationService,
  IUndoRedoService,
  IWorkspaceService,
  InstantiationService,
  MenuId,
  MenuRegistry,
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
  type IObservable,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
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
import { DragSessionProvider } from '@universe-editor/workbench-ui'

function makeFs(initial: Record<string, IDirectoryEntry[]> = {}): IFileServiceType & {
  dirs: Map<string, IDirectoryEntry[]>
  renameCalls: Array<{ src: string; dest: string }>
} {
  const dirs = new Map(Object.entries(initial))
  const renameCalls: Array<{ src: string; dest: string }> = []
  return {
    _serviceBrand: undefined,
    dirs,
    renameCalls,
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
    async rename(src: URI, dest: URI) {
      renameCalls.push({ src: src.toString(), dest: dest.toString() })
    },
    async copy() {},
    async listRecursive() {
      return []
    },
  } as ReturnType<typeof makeFs>
}

class FakeWorkspace implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace = new Emitter<IWorkspace | null>().event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()
  constructor(folder: URI | null) {
    this.current = folder ? { folder, name: 'ws' } : null
  }
  async openFolder() {}
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

function makeNoopWatcher(): IFileWatcherServiceType {
  return {
    _serviceBrand: undefined,
    onDidChangeFiles: new Emitter<readonly never[]>().event,
    async watch() {},
    async unwatch() {},
    async setExcludes() {},
  } as unknown as IFileWatcherServiceType
}

function renderView(opts: { folder: URI | null; fs?: ReturnType<typeof makeFs> }) {
  const services = new ServiceCollection()
  const fs = opts.fs ?? makeFs()
  const ws = new FakeWorkspace(opts.folder)
  const editor = new FakeEditor()
  services.set(IFileService, fs)
  services.set(IFileWatcherService, makeNoopWatcher())
  services.set(IExcludeService, new FakeExcludeService())
  services.set(IWorkspaceService, ws)
  services.set(IEditorService, editor as unknown as IEditorService)
  const commandCalls: Array<{ id: string; args: unknown[] }> = []
  services.set(ICommandService, {
    _serviceBrand: undefined,
    async executeCommand(id: string, ...args: unknown[]) {
      commandCalls.push({ id, args })
    },
    registerCommand() {
      return { dispose() {} }
    },
  } as unknown as ICommandService)
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
    prompt: async () => undefined,
  } as unknown as IDialogServiceType)
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
  const undoDialog: IDialogServiceType = {
    _serviceBrand: undefined,
    confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
    prompt: async () => undefined,
  }
  services.set(IUndoRedoService, new UndoRedoService(undoDialog, notification))
  const tree = inst.createInstance(ExplorerTreeService)
  services.set(IExplorerTreeService, tree)
  services.set(IExplorerFileOperationService, inst.createInstance(ExplorerFileOperationService))
  const result = render(
    <ServicesContext.Provider value={inst}>
      <DragSessionProvider>
        <ExplorerView />
      </DragSessionProvider>
    </ServicesContext.Provider>,
  )
  return { ...result, ws, editor, fs, tree, commandCalls }
}

afterEach(() => cleanup())

describe('ExplorerView — compact folders', () => {
  const root = URI.file('/ws')
  const src = URI.joinPath(root, 'src')
  const lib = URI.joinPath(src, 'lib')

  it('renders the compact merged path as one row with per-segment spans', async () => {
    const fs = makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [],
    })
    const { container } = renderView({ folder: root, fs })
    // The compact node is a single tree row keyed by the leaf (lib).
    const row = await waitFor(() => {
      const r = container.querySelector<HTMLElement>(`[data-row-key="${lib.toString()}"]`)
      expect(r).toBeTruthy()
      return r!
    })
    // It carries both path segments rendered as independent spans.
    expect(row.querySelector(`[data-segment-uri="${src.toString()}"]`)?.textContent).toBe('src')
    expect(row.querySelector(`[data-segment-uri="${lib.toString()}"]`)?.textContent).toBe('lib')
    // There is NO separate intermediate tree row for src.
    expect(container.querySelector(`[data-row-key="${src.toString()}"]`)).toBeNull()
  })

  it('drag source of compact node is compactRoot (src), not the leaf (lib)', async () => {
    const fs = makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [],
    })
    const { container } = renderView({ folder: root, fs })

    const row = await waitFor(() => {
      const r = container.querySelector<HTMLElement>(`[data-row-key="${lib.toString()}"]`)
      expect(r).toBeTruthy()
      return r!
    })

    // The drag handle should expose compactRoot (src) via data-drag-source
    // When the user drags this compact node, the ENTIRE src chain should move
    expect(row.getAttribute('data-drag-source')).toBe(src.toString())
  })

  it('drop onto the compact row (no segment hovered) resolves to the leaf (lib)', async () => {
    const fs = makeFs({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'other.ts', isFile: true, isDirectory: false },
      ],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [],
    })
    const { container, getByText, fs: mockFs } = renderView({ folder: root, fs })

    const row = await waitFor(() => {
      const r = container.querySelector<HTMLElement>(`[data-row-key="${lib.toString()}"]`)
      expect(r).toBeTruthy()
      return r!
    })

    // Simulate: drag "other.ts" onto the compact node — with no segment hovered
    // it defaults to lib (the leaf), so dest = lib/other.ts
    const otherRow = getByText('other.ts').closest('[role="treeitem"]')
    expect(otherRow).toBeTruthy()

    fireEvent.dragStart(otherRow!)
    fireEvent.drop(row)

    await waitFor(() => {
      expect(mockFs.renameCalls.length).toBeGreaterThan(0)
    })
    const call = mockFs.renameCalls[0]!
    // Destination must be inside lib (the leaf), NOT inside src
    expect(call.dest.startsWith(lib.toString())).toBe(true)
  })
})

describe('ExplorerView — compact folders segment targeting', () => {
  const root = URI.file('/ws')
  const src = URI.joinPath(root, 'src')
  const lib = URI.joinPath(src, 'lib')

  function seg(container: HTMLElement, uri: URI): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-segment-uri="${uri.toString()}"]`)
  }

  it('dropping a file onto the "src" segment lands it in src, not lib', async () => {
    const fs = makeFs({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'other.ts', isFile: true, isDirectory: false },
      ],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [],
    })
    const { container, getByText, fs: mockFs } = renderView({ folder: root, fs })

    // Wait for the compact node to render its per-segment spans.
    const srcSeg = await waitFor(() => {
      const s = seg(container, src)
      expect(s).toBeTruthy()
      return s!
    })

    const otherRow = getByText('other.ts').closest('[role="treeitem"]')
    expect(otherRow).toBeTruthy()

    fireEvent.dragStart(otherRow!)
    // Hovering the "src" segment during the drag must retarget the drop to src.
    fireEvent.dragEnter(srcSeg)
    fireEvent.dragOver(srcSeg)
    fireEvent.drop(srcSeg)

    await waitFor(() => expect(mockFs.renameCalls.length).toBeGreaterThan(0))
    const call = mockFs.renameCalls[0]!
    expect(call.dest).toBe(`${src.toString()}/other.ts`)
  })

  it('right-clicking the "src" segment makes context actions target src (New File parent)', async () => {
    const cmdId = 'test.explorer.newFile'
    const cmdDisposable = CommandsRegistry.registerCommand(cmdId, () => {}, { description: 'New' })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
      command: cmdId,
      title: 'New File',
    })
    try {
      const fs = makeFs({
        [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
        [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
        [lib.toString()]: [],
      })
      const { container, getByText, commandCalls } = renderView({ folder: root, fs })

      const srcSeg = await waitFor(() => {
        const s = seg(container, src)
        expect(s).toBeTruthy()
        return s!
      })

      fireEvent.contextMenu(srcSeg)
      fireEvent.click(getByText('New File'))

      expect(commandCalls.length).toBe(1)
      const arg = commandCalls[0]?.args[0] as { parent: URI; resource: URI } | undefined
      // The New File parent must be the hovered segment (src), not the leaf (lib).
      expect(arg?.parent.toString()).toBe(src.toString())
    } finally {
      menuDisposable.dispose()
      cmdDisposable.dispose()
    }
  })

  it('hovering a segment marks only that segment active', async () => {
    const fs = makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [],
    })
    const { container } = renderView({ folder: root, fs })

    const srcSeg = await waitFor(() => {
      const s = seg(container, src)
      expect(s).toBeTruthy()
      return s!
    })
    const libSeg = seg(container, lib)
    expect(libSeg).toBeTruthy()

    fireEvent.mouseEnter(srcSeg)
    expect(srcSeg.getAttribute('data-segment-active')).toBe('true')
    expect(libSeg!.getAttribute('data-segment-active')).not.toBe('true')
  })
})
