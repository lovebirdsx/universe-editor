/*---------------------------------------------------------------------------------------------
 *  Tests for the three-state Explorer UX: active-editor marker / selection /
 *  focused row. Renders the real ExplorerView with the real ExplorerTreeService
 *  and the real ExplorerAutoRevealContribution so the wiring is exercised
 *  end-to-end (DOM class names).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ConfigurationService,
  ConfigurationTarget,
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
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { ExplorerAutoRevealContribution } from '../../../contributions/ExplorerAutoRevealContribution.js'
import { ServicesContext } from '../../useService.js'
import styles from '../ExplorerView.module.css'
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
  constructor(folder: URI | null) {
    this.current = folder ? { folder, name: 'ws' } : null
  }
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
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
    this.activeEditor.set(input, undefined)
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

function setup(opts: { autoReveal?: boolean } = {}) {
  const root = URI.file('/ws')
  const fs = makeFs({
    [root.toString()]: [
      { name: 'src', isFile: false, isDirectory: true },
      { name: 'README.md', isFile: true, isDirectory: false },
      { name: 'a.txt', isFile: true, isDirectory: false },
    ],
    [URI.joinPath(root, 'src').toString()]: [
      { name: 'index.ts', isFile: true, isDirectory: false },
    ],
  })
  const services = new ServiceCollection()
  const ws = new FakeWorkspace(root)
  const editor = new FakeEditor()
  const command = new FakeCommand()
  const dialog: IDialogServiceType = {
    _serviceBrand: undefined,
    confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
    prompt: async () => undefined,
  }
  const config = new ConfigurationService()
  if (opts.autoReveal !== undefined) {
    config.update('explorer.autoReveal', opts.autoReveal, ConfigurationTarget.Memory)
  }
  services.set(IFileService, fs)
  services.set(IFileWatcherService, makeNoopWatcher())
  services.set(IWorkspaceService, ws)
  services.set(IEditorService, editor as unknown as IEditorService)
  services.set(ICommandService, command as unknown as ICommandService)
  services.set(IDialogService, dialog)
  services.set(IConfigurationService, config)
  const inst = new InstantiationService(services)
  const editorResolver = inst.createInstance(EditorResolverService)
  services.set(IEditorResolverService, editorResolver)
  const tree = inst.createInstance(ExplorerTreeService)
  services.set(IExplorerTreeService, tree)
  const contrib = inst.createInstance(ExplorerAutoRevealContribution)
  const result = render(
    <ServicesContext.Provider value={inst}>
      <ExplorerView />
    </ServicesContext.Provider>,
  )
  return { ...result, tree, editor, command, fs, inst, contrib, root }
}

function rowFor(name: string): HTMLElement {
  const label = screen.getByText(name)
  const row = label.closest('[role="treeitem"]')
  if (!row) throw new Error(`No treeitem found for "${name}"`)
  return row as HTMLElement
}

afterEach(() => cleanup())

describe('ExplorerView — three-state UI', () => {
  it('single-click marks the row .selected and .focused', async () => {
    setup()
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('README.md'))
    const row = rowFor('README.md')
    expect(row.className).toContain(styles['selected']!)
    expect(row.className).toContain(styles['focused']!)
  })

  it('Ctrl+Click adds a second row to the selection without opening it', async () => {
    const { editor } = setup()
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('README.md'))
    editor.opened.length = 0 // ignore the open caused by single-click
    fireEvent.click(screen.getByText('a.txt'), { ctrlKey: true })
    expect(rowFor('README.md').className).toContain(styles['selected']!)
    expect(rowFor('a.txt').className).toContain(styles['selected']!)
    expect(editor.opened).toHaveLength(0)
  })

  it('Shift+Click selects the visible-order range without opening', async () => {
    const { editor, tree, root } = setup()
    await screen.findByText('README.md')
    await tree.expand(URI.joinPath(root, 'src'))
    await screen.findByText('index.ts')
    // Anchor on a file (clicking a directory would toggle it). Visible order
    // (alphabetical within directory, dirs first): ws-root, src, src/index.ts,
    // a.txt, README.md — so index.ts → README.md spans index.ts/a.txt/README.md.
    fireEvent.click(screen.getByText('index.ts'))
    editor.opened.length = 0
    fireEvent.click(screen.getByText('README.md'), { shiftKey: true })
    expect(rowFor('index.ts').className).toContain(styles['selected']!)
    expect(rowFor('a.txt').className).toContain(styles['selected']!)
    expect(rowFor('README.md').className).toContain(styles['selected']!)
    expect(editor.opened).toHaveLength(0)
  })

  it('active editor marker reflects the open editor (autoReveal default on)', async () => {
    const { editor, inst, root } = setup()
    await screen.findByText('README.md')
    const input = inst.createInstance(FileEditorInput, URI.joinPath(root, 'README.md'))
    editor.activeEditor.set(input, undefined)
    await waitFor(() => {
      expect(rowFor('README.md').className).toContain(styles['active']!)
    })
    // autoReveal on (default) → also selected + focused
    expect(rowFor('README.md').className).toContain(styles['selected']!)
  })

  it('active marker tracks editor switch independent of mouse selection', async () => {
    const { editor, tree, inst, root } = setup({ autoReveal: false })
    await screen.findByText('README.md')
    // User selects file A in the explorer (direct service call to avoid the
    // async open-editor race that fireEvent.click would introduce).
    tree.setSelection([URI.joinPath(root, 'a.txt')], URI.joinPath(root, 'a.txt'))
    // Editor activates a DIFFERENT file (e.g. via tab switch).
    const input = inst.createInstance(FileEditorInput, URI.joinPath(root, 'README.md'))
    editor.activeEditor.set(input, undefined)
    await waitFor(() => {
      expect(rowFor('README.md').className).toContain(styles['active']!)
    })
    // With autoReveal off, the user's selection should NOT move to README.md.
    expect(rowFor('a.txt').className).toContain(styles['selected']!)
    expect(rowFor('README.md').className).not.toContain(styles['selected']!)
  })

  it('ArrowDown moves focus and renders .focused on the new row', async () => {
    setup()
    await screen.findByText('README.md')
    const view = screen.getByRole('tree')
    view.focus()
    fireEvent.keyDown(view, { key: 'ArrowDown' })
    // First ArrowDown from no focus should land on visible[0] = workspace root.
    fireEvent.keyDown(view, { key: 'ArrowDown' })
    // Now on visible[1] = 'src'
    expect(rowFor('src').className).toContain(styles['focused']!)
  })

  it('Shift+ArrowDown extends the selection by one row from current focus', async () => {
    const { tree, root } = setup()
    await screen.findByText('README.md')
    // Visible order (alphabetical within dir, dirs first): ws, src, a.txt,
    // README.md. Anchor on a.txt so Shift+ArrowDown extends down to README.md.
    tree.setSelection([URI.joinPath(root, 'a.txt')], URI.joinPath(root, 'a.txt'))
    const view = screen.getByRole('tree')
    view.focus()
    fireEvent.keyDown(view, { key: 'ArrowDown', shiftKey: true })
    expect(rowFor('a.txt').className).toContain(styles['selected']!)
    expect(rowFor('README.md').className).toContain(styles['selected']!)
    expect(rowFor('README.md').className).toContain(styles['focused']!)
  })
})
