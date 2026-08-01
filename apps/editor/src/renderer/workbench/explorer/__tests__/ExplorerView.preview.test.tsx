/*---------------------------------------------------------------------------------------------
 *  Tests for ExplorerView — preview semantics on single vs double click (主题 11 WP2).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  IDialogService,
  IEditorGroupsService,
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
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IEditorInput,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type IObservable,
  type IOpenEditorServiceOptions,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ExplorerView } from '../ExplorerView.js'
import { MarkdownPreviewInput } from '../../../services/editor/MarkdownPreviewInput.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from '../../../services/explorer/ExplorerTreeService.js'
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
  registerCommand() {
    return { dispose() {} }
  }
  async executeCommand() {}
}

class FakeEditorGroup {
  activeEditor: unknown
  opened: Array<{ input: unknown; options: unknown }> = []
  indexOf(): number {
    return -1
  }
  openEditor(input: unknown, options?: unknown): void {
    this.opened.push({ input, options })
    this.activeEditor = input
  }
  closeEditor(): void {}
}

function makeNoopWatcher(): IFileWatcherServiceType {
  return {
    _serviceBrand: undefined,
    onDidChangeFiles: new Emitter<readonly never[]>().event,
    onDidRestart: new Emitter<void>().event,
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
  const editorGroup = new FakeEditorGroup()
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: editorGroup,
  } as unknown as IEditorGroupsServiceType)
  const tree = inst.createInstance(ExplorerTreeService)
  services.set(IExplorerTreeService, tree)
  const result = render(
    <ServicesContext.Provider value={inst}>
      <ExplorerView />
    </ServicesContext.Provider>,
  )
  return { ...result, editor, editorGroup }
}

afterEach(() => cleanup())

describe('ExplorerView — preview', () => {
  it('single-click opens with pinned:false (preview) and preserves Explorer focus', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [{ name: 'README.md', isFile: true, isDirectory: false }],
    })
    const { editor } = renderView(root, fs)
    fireEvent.click(await screen.findByText('README.md'))
    await waitFor(() => expect(editor.opened).toHaveLength(1))
    expect(editor.opened[0]?.options?.pinned).toBe(false)
    expect(editor.opened[0]?.options?.preserveFocus).toBe(true)
  })

  it('double-click opens with pinned:true and hands focus to the editor', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [{ name: 'README.md', isFile: true, isDirectory: false }],
    })
    const { editor } = renderView(root, fs)
    const label = await screen.findByText('README.md')
    fireEvent.doubleClick(label)
    // dblclick in jsdom also fires a click event first; both should reach the handler.
    await waitFor(() => expect(editor.opened.length).toBeGreaterThanOrEqual(1))
    const pinnedOpen = editor.opened.find((o) => o.options?.pinned === true)
    expect(pinnedOpen).toBeDefined()
    expect(pinnedOpen?.options?.preserveFocus).not.toBe(true)
  })

  it('hover preview button opens a markdown preview for previewable files', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [{ name: 'README.md', isFile: true, isDirectory: false }],
    })
    const { editorGroup } = renderView(root, fs)
    const label = await screen.findByText('README.md')
    const row = label.closest('[role="treeitem"]') as HTMLElement
    fireEvent.click(within(row).getByTestId('explorer-open-preview'))
    await waitFor(() => expect(editorGroup.opened).toHaveLength(1))
    const input = editorGroup.opened[0]?.input
    expect(input).toBeInstanceOf(MarkdownPreviewInput)
    expect(editorGroup.opened[0]?.options).toEqual({ activate: true, pinned: true })
    expect((input as MarkdownPreviewInput | undefined)?.sourceUri.fsPath).toContain('README.md')
  })

  it('does not render a preview button for non-previewable files', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [{ name: 'main.ts', isFile: true, isDirectory: false }],
    })
    renderView(root, fs)
    await screen.findByText('main.ts')
    expect(screen.queryByTestId('explorer-open-preview')).toBeNull()
  })
})
