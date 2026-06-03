/*---------------------------------------------------------------------------------------------
 *  Tests for the file* Action2 verb modules (Save / Create / Mutate / Open).
 *
 *  Drives the Action2 handlers directly via the CommandsRegistry, with fake
 *  implementations of IFileService / IDialogService / IHostService /
 *  IExplorerTreeService / IEditorGroupsService injected through DI.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  ICommandService,
  IDialogService,
  IEditorGroupsService,
  IFileService,
  IFileWatcherService,
  IHostService,
  IInstantiationService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type EditorInput,
  type ICommandService as ICommandServiceType,
  type IConfirmOptions,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
  type IDirectoryEntry,
  type IEditorGroup,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type IHostService as IHostServiceType,
  type IPromptOptions,
  type IShowOpenFileOptions,
  type IShowSaveFileOptions,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
  type UriComponents,
} from '@universe-editor/platform'
import { SaveFileAction, SaveFileAsAction } from '../fileSaveActions.js'
import { NewFileAction, NewFolderAction, NewUntitledFileAction } from '../fileCreateActions.js'
import { DeleteFileAction, RenameFileAction } from '../fileMutateActions.js'
import { OpenFileAction } from '../fileOpenActions.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from '../../services/explorer/ExplorerTreeService.js'
import { IExcludeService } from '../../services/exclude/ExcludeService.js'
import { FakeExcludeService } from '../../services/exclude/testing/fakeExcludeService.js'
import { UntitledEditorInput } from '../../services/editor/UntitledEditorInput.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeNoopWatcher(): IFileWatcherServiceType {
  return {
    _serviceBrand: undefined,
    onDidChangeFiles: new Emitter<readonly never[]>().event,
    async watch() {},
    async unwatch() {},
  } as unknown as IFileWatcherServiceType
}

function makeFs(initial: Record<string, IDirectoryEntry[]> = {}): IFileServiceType & {
  files: Set<string>
  dirs: Map<string, IDirectoryEntry[]>
  writes: Array<{ path: string; content: string }>
} {
  const dirs = new Map<string, IDirectoryEntry[]>()
  for (const [k, v] of Object.entries(initial)) dirs.set(k, v)
  const files = new Set<string>()
  const writes: Array<{ path: string; content: string }> = []
  return {
    _serviceBrand: undefined,
    files,
    dirs,
    writes,
    async readFile() {
      throw new Error('not used')
    },
    async readFileText() {
      throw new Error('not used')
    },
    async writeFile(resource: URI, content: Uint8Array | string) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
      writes.push({ path: resource.toString(), content: text })
      files.add(resource.toString())
    },
    async exists(resource: URI) {
      return files.has(resource.toString()) || dirs.has(resource.toString())
    },
    async stat() {
      throw new Error('not used')
    },
    async list(resource: URI) {
      return dirs.get(resource.toString()) ?? []
    },
    async createDirectory(resource: URI) {
      dirs.set(resource.toString(), [])
    },
    async delete(resource: URI) {
      files.delete(resource.toString())
      dirs.delete(resource.toString())
    },
    async rename(source: URI, target: URI) {
      if (files.delete(source.toString())) files.add(target.toString())
      const d = dirs.get(source.toString())
      if (d !== undefined) {
        dirs.delete(source.toString())
        dirs.set(target.toString(), d)
      }
    },
  } as never
}

class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _changed = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._changed.event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()

  constructor(initial: URI | null) {
    this.current = initial ? { folder: initial, name: 'ws' } : null
  }
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

class FakeDialogService implements IDialogServiceType {
  declare readonly _serviceBrand: undefined
  confirmResults: IConfirmResult[] = []
  promptResults: (string | undefined)[] = []
  readonly confirmCalls: IConfirmOptions[] = []
  readonly promptCalls: IPromptOptions[] = []

  async confirm(opts: IConfirmOptions): Promise<IConfirmResult> {
    this.confirmCalls.push(opts)
    return this.confirmResults.shift() ?? { confirmed: false, choice: 'cancel' }
  }
  async prompt(opts: IPromptOptions): Promise<string | undefined> {
    this.promptCalls.push(opts)
    return this.promptResults.shift()
  }
}

class FakeHostService implements IHostServiceType {
  declare readonly _serviceBrand: undefined
  readonly platform = 'win32' as const
  readonly onDidChangeMaximized = new Emitter<boolean>().event
  openResult: URI | UriComponents | null = null
  saveResult: URI | UriComponents | null = null
  readonly openCalls: IShowOpenFileOptions[] = []
  readonly saveCalls: IShowSaveFileOptions[] = []

  async isMaximized() {
    return false
  }
  async minimizeWindow() {}
  async toggleMaximizeWindow() {}
  async closeWindow() {}
  async restart() {}
  async toggleDevTools() {}
  async getVersionInfo() {
    return {
      productName: 'Universe Editor',
      version: '1.2.3',
      electron: '33.0.0',
      node: '20.0.0',
      chromium: '128.0.0',
      v8: '12.0.0',
    }
  }
  async showOpenFileDialog(opts?: IShowOpenFileOptions) {
    this.openCalls.push(opts ?? {})
    return this.openResult
  }
  async showSaveFileDialog(opts?: IShowSaveFileOptions) {
    this.saveCalls.push(opts ?? {})
    return this.saveResult
  }
  async showItemInFolder(_fsPath: string) {}
  async openWithDefaultApp(_path: string) {
    return ''
  }
  async openInVSCode(_fsPath: string) {
    return ''
  }
  async openUserDataFolder() {}
  async openNewWindow() {}
  async openTerminal() {}
  async notify() {
    return { shown: false, clicked: false }
  }
  async focusWindow() {}
}

class FakeCommandService implements ICommandServiceType {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{ id: string; args: unknown[] }> = []
  results = new Map<string, unknown>()

  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    this.calls.push({ id, args })
    return this.results.get(id) as T | undefined
  }
}

interface FakeGroup extends IEditorGroup {
  readonly opened: EditorInput[]
  readonly closed: EditorInput[]
}

function makeGroup(activeEditor?: EditorInput): {
  group: FakeGroup
  service: IEditorGroupsServiceType
} {
  const opened: EditorInput[] = []
  const closed: EditorInput[] = []
  const group = {
    activeEditor,
    opened,
    closed,
    openEditor(e: EditorInput) {
      opened.push(e)
    },
    closeEditor(e: EditorInput) {
      closed.push(e)
      return true
    },
  } as unknown as FakeGroup
  const service = { activeGroup: group } as unknown as IEditorGroupsServiceType
  return { group, service }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  inst: InstantiationService
  fs: ReturnType<typeof makeFs>
  ws: FakeWorkspaceService
  dialog: FakeDialogService
  host: FakeHostService
  tree: ExplorerTreeService
  group: FakeGroup
  groupsService: IEditorGroupsServiceType
  cmd: FakeCommandService
}

function makeHarness(opts: { root?: URI; activeEditor?: EditorInput } = {}): Harness {
  const root = opts.root ?? URI.file('/ws')
  const fs = makeFs({ [root.toString()]: [] })
  const ws = new FakeWorkspaceService(root)
  const dialog = new FakeDialogService()
  const host = new FakeHostService()
  const cmd = new FakeCommandService()
  const { group, service: groupsService } = makeGroup(opts.activeEditor)

  const services = new ServiceCollection()
  services.set(IFileService, fs)
  services.set(IFileWatcherService, makeNoopWatcher())
  services.set(IExcludeService, new FakeExcludeService())
  services.set(IWorkspaceService, ws)
  services.set(IDialogService, dialog)
  services.set(IHostService, host)
  services.set(IEditorGroupsService, groupsService)
  services.set(ICommandService, cmd)
  const inst = new InstantiationService(services)
  // ExplorerTreeService needs IWorkspaceService + IFileService.
  const tree = inst.createInstance(ExplorerTreeService)
  services.set(IExplorerTreeService, tree)
  // Re-set inst's snapshot in case the runner needs it
  services.set(IInstantiationService, inst as unknown as IInstantiationService)

  return { inst, fs, ws, dialog, host, tree, group, groupsService, cmd }
}

function run(h: Harness, id: string, args?: unknown): Promise<unknown> {
  const cmd = CommandsRegistry.getCommand(id)
  if (!cmd) throw new Error(`Command ${id} not registered`)
  return h.inst.invokeFunction((accessor) => cmd.handler(accessor, args)) as Promise<unknown>
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const disposables: Array<{ dispose(): void }> = []
beforeEach(() => {
  disposables.push(registerAction2(SaveFileAction))
  disposables.push(registerAction2(SaveFileAsAction))
  disposables.push(registerAction2(OpenFileAction))
  disposables.push(registerAction2(NewFileAction))
  disposables.push(registerAction2(NewFolderAction))
  disposables.push(registerAction2(NewUntitledFileAction))
  disposables.push(registerAction2(RenameFileAction))
  disposables.push(registerAction2(DeleteFileAction))
})
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fileActions', () => {
  describe('SaveFileAction', () => {
    it('calls save() on the active editor', async () => {
      const save = vi.fn().mockResolvedValue(true)
      const active = { save, isDirty: true } as unknown as EditorInput
      const h = makeHarness({ activeEditor: active })
      await run(h, SaveFileAction.ID)
      expect(save).toHaveBeenCalledTimes(1)
    })

    it('no-ops when there is no active editor', async () => {
      const h = makeHarness()
      await expect(run(h, SaveFileAction.ID)).resolves.toBeUndefined()
    })

    it('delegates to SaveFileAsAction when the active editor is untitled', async () => {
      const h = makeHarness()
      const untitled = h.inst.createInstance(UntitledEditorInput)
      ;(h.group as unknown as { activeEditor: EditorInput }).activeEditor = untitled
      await run(h, SaveFileAction.ID)
      expect(h.cmd.calls.map((c) => c.id)).toContain(SaveFileAsAction.ID)
    })
  })

  describe('OpenFileAction', () => {
    it('opens the picked file in the active group', async () => {
      const h = makeHarness()
      const picked = URI.file('/picked.txt')
      h.host.openResult = picked.toJSON()
      await run(h, OpenFileAction.ID)
      expect(h.group.opened).toHaveLength(1)
      expect(h.group.opened[0]?.resource?.toString()).toBe(picked.toString())
    })

    it('does nothing when the user cancels the picker', async () => {
      const h = makeHarness()
      h.host.openResult = null
      await run(h, OpenFileAction.ID)
      expect(h.group.opened).toHaveLength(0)
    })
  })

  describe('NewFileAction', () => {
    it('prompts, creates the file, and opens it', async () => {
      const h = makeHarness()
      h.dialog.promptResults.push('hello.txt')
      const parent = URI.file('/ws')
      await run(h, NewFileAction.ID, { parent })
      expect(h.dialog.promptCalls[0]?.title).toBe('New File')
      expect(h.fs.writes.map((w) => w.path)).toContain(URI.joinPath(parent, 'hello.txt').toString())
      expect(h.group.opened).toHaveLength(1)
    })

    it('uses the containing folder when invoked from a file context menu target', async () => {
      const h = makeHarness()
      h.dialog.promptResults.push('hello.txt')
      const target = URI.file('/ws/src/main.ts')
      await run(h, NewFileAction.ID, { resource: target, isDirectory: false })
      expect(h.fs.writes.map((w) => w.path)).toContain(URI.file('/ws/src/hello.txt').toString())
    })

    it('no-ops when the prompt is cancelled', async () => {
      const h = makeHarness()
      h.dialog.promptResults.push(undefined)
      await run(h, NewFileAction.ID, { parent: URI.file('/ws') })
      expect(h.fs.writes).toEqual([])
      expect(h.group.opened).toEqual([])
    })
  })

  describe('NewFolderAction', () => {
    it('prompts and creates the directory', async () => {
      const h = makeHarness()
      h.dialog.promptResults.push('sub')
      const parent = URI.file('/ws')
      await run(h, NewFolderAction.ID, { parent })
      expect(h.fs.dirs.has(URI.joinPath(parent, 'sub').toString())).toBe(true)
    })
  })

  describe('RenameFileAction', () => {
    it('renames the target to the prompted value', async () => {
      const root = URI.file('/ws')
      const source = URI.joinPath(root, 'a.txt')
      const h = makeHarness({ root })
      h.fs.files.add(source.toString())
      h.dialog.promptResults.push('b.txt')
      await run(h, RenameFileAction.ID, { target: source })
      const next = URI.joinPath(root, 'b.txt').toString()
      expect(h.fs.files.has(next)).toBe(true)
      expect(h.fs.files.has(source.toString())).toBe(false)
    })

    it('accepts resource-style args from the Explorer context menu', async () => {
      const root = URI.file('/ws')
      const source = URI.joinPath(root, 'a.txt')
      const h = makeHarness({ root })
      h.fs.files.add(source.toString())
      h.dialog.promptResults.push('b.txt')
      await run(h, RenameFileAction.ID, { resource: source, isDirectory: false })
      expect(h.fs.files.has(URI.joinPath(root, 'b.txt').toString())).toBe(true)
    })

    it('no-ops when prompt returns same name', async () => {
      const root = URI.file('/ws')
      const source = URI.joinPath(root, 'a.txt')
      const h = makeHarness({ root })
      h.fs.files.add(source.toString())
      h.dialog.promptResults.push('a.txt')
      await run(h, RenameFileAction.ID, { target: source })
      expect(h.fs.files.has(source.toString())).toBe(true)
    })
  })

  describe('DeleteFileAction', () => {
    it('confirms then deletes a file', async () => {
      const root = URI.file('/ws')
      const target = URI.joinPath(root, 'a.txt')
      const h = makeHarness({ root })
      h.fs.files.add(target.toString())
      h.dialog.confirmResults.push({ confirmed: true, choice: 'primary' })
      await run(h, DeleteFileAction.ID, { target, isDirectory: false })
      expect(h.fs.files.has(target.toString())).toBe(false)
    })

    it('accepts resource-style args from the Explorer context menu', async () => {
      const root = URI.file('/ws')
      const target = URI.joinPath(root, 'a.txt')
      const h = makeHarness({ root })
      h.fs.files.add(target.toString())
      h.dialog.confirmResults.push({ confirmed: true, choice: 'primary' })
      await run(h, DeleteFileAction.ID, { resource: target, isDirectory: false })
      expect(h.fs.files.has(target.toString())).toBe(false)
    })

    it('falls back to the current Explorer selection when invoked without args', async () => {
      const root = URI.file('/ws')
      const target = URI.joinPath(root, 'a.txt')
      const h = makeHarness({ root })
      h.fs.files.add(target.toString())
      h.tree.setSelection([target], target)
      h.dialog.confirmResults.push({ confirmed: true, choice: 'primary' })
      await run(h, DeleteFileAction.ID)
      expect(h.fs.files.has(target.toString())).toBe(false)
    })

    it('skips delete when the user cancels the confirm', async () => {
      const root = URI.file('/ws')
      const target = URI.joinPath(root, 'a.txt')
      const h = makeHarness({ root })
      h.fs.files.add(target.toString())
      h.dialog.confirmResults.push({ confirmed: false, choice: 'cancel' })
      await run(h, DeleteFileAction.ID, { target, isDirectory: false })
      expect(h.fs.files.has(target.toString())).toBe(true)
    })

    it('passes recursive=true for directory deletes', async () => {
      const root = URI.file('/ws')
      const target = URI.joinPath(root, 'sub')
      const h = makeHarness({ root })
      h.fs.dirs.set(target.toString(), [])
      h.dialog.confirmResults.push({ confirmed: true, choice: 'primary' })
      const spy = vi.spyOn(h.fs, 'delete')
      await run(h, DeleteFileAction.ID, { target, isDirectory: true })
      expect(spy).toHaveBeenCalledWith(expect.anything(), { recursive: true })
    })
  })

  describe('SaveFileAsAction', () => {
    it('no-ops when the active editor is not a FileEditorInput', async () => {
      const active = { isDirty: false, typeId: 'welcome' } as unknown as EditorInput
      const h = makeHarness({ activeEditor: active })
      await expect(run(h, SaveFileAsAction.ID)).resolves.toBeUndefined()
      expect(h.host.saveCalls).toHaveLength(0)
    })
  })

  describe('NewUntitledFileAction', () => {
    it('opens a fresh untitled input in the active group', async () => {
      const h = makeHarness()
      await run(h, NewUntitledFileAction.ID)
      expect(h.group.opened).toHaveLength(1)
      const opened = h.group.opened[0]
      expect(opened).toBeInstanceOf(UntitledEditorInput)
      expect(opened?.typeId).toBe('untitled')
    })
  })
})
