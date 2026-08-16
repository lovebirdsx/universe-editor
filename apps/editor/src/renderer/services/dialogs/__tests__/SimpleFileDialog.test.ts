/*---------------------------------------------------------------------------------------------
 *  Host-level tests for SimpleFileDialog: reproduce the VSCode keyboard-interaction
 *  parity bugs (A-D) and the `~` home expansion, driving a fake QuickPick + a fake
 *  in-memory IFileService. Renderer-node (no DOM).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullLogger, REMOTE_SCHEME, URI } from '@universe-editor/platform'
import type {
  IConfigurationService,
  IDialogService,
  IDirectoryEntry,
  IFileService,
  IFileStat,
  IHostService,
  ILoggerService,
  IQuickPickItem,
  IShowOpenFileOptions,
  IShowSaveFileOptions,
  IWorkspaceService,
  UriComponents,
} from '@universe-editor/platform'
import { SimpleFileDialog } from '../SimpleFileDialog.js'
import type { RemoteEnvironmentDto } from '../../../../shared/ipc/remoteStatusService.js'

class Emitter<T> {
  private readonly _listeners: Array<(e: T) => void> = []
  readonly event = (fn: (e: T) => void): { dispose(): void } => {
    this._listeners.push(fn)
    return { dispose: () => undefined }
  }
  fire(e: T): void {
    for (const fn of [...this._listeners]) fn(e)
  }
}

class FakeQuickPick {
  value = ''
  valueSelection: [number, number] | undefined
  items: readonly IQuickPickItem[] = []
  activeItems: readonly IQuickPickItem[] = []
  selectedItems: readonly IQuickPickItem[] = []
  busy = false
  buttons: readonly unknown[] = []
  filterExternally = false
  keepOpenOnAccept = false
  canSelectMany = false
  title: string | undefined
  okLabel: string | undefined

  private readonly _onAccept = new Emitter<IQuickPickItem[]>()
  private readonly _onChangeValue = new Emitter<string>()
  private readonly _onChangeActive = new Emitter<IQuickPickItem | undefined>()
  private readonly _onChangeSelection = new Emitter<IQuickPickItem[]>()
  private readonly _onTriggerOk = new Emitter<void>()
  private readonly _onTriggerButton = new Emitter<unknown>()
  private readonly _onHide = new Emitter<void>()

  readonly onDidAccept = this._onAccept.event
  readonly onDidChangeValue = this._onChangeValue.event
  readonly onDidChangeActive = this._onChangeActive.event
  readonly onDidChangeSelection = this._onChangeSelection.event
  readonly onDidTriggerOk = this._onTriggerOk.event
  readonly onDidTriggerButton = this._onTriggerButton.event
  readonly onDidHide = this._onHide.event

  show(): void {}
  hide(): void {}
  dispose(): void {}

  /** Simulate the user typing: set the value and fire the change event. */
  type(value: string): void {
    this.value = value
    this._onChangeValue.fire(value)
  }
  fireActive(item: IQuickPickItem | undefined): void {
    this._onChangeActive.fire(item)
  }
  accept(): void {
    this._onAccept.fire([...this.activeItems])
  }
  triggerOk(): void {
    this._onTriggerOk.fire()
  }
  triggerButton(): void {
    this._onTriggerButton.fire(this.buttons[0])
  }
  /** Simulate the panel's checkbox toggle: propose the next checked set. */
  fireSelection(items: IQuickPickItem[]): void {
    this._onChangeSelection.fire(items)
  }
}

class FakeQuickInputService {
  declare readonly _serviceBrand: undefined
  lastPick!: FakeQuickPick
  createQuickPick(): FakeQuickPick {
    this.lastPick = new FakeQuickPick()
    return this.lastPick
  }
}

// In-memory filesystem keyed by URI path. Directories map to their child names;
// files live in a separate set.
const DIRS = new Map<string, string[]>([
  ['/a', ['git_project', 'src', 'readme.md', 'notes.txt', 'pic.png', '.hidden']],
  ['/a/git_project', []],
  ['/a/src', ['code.ts']],
  ['/a/.hidden', []],
  ['/b', ['foo']],
  ['/b/foo', []],
  ['/home/u', ['Documents']],
  ['/home/u/Documents', []],
  // Remote host layout (browsed via a remote: URI — keyed by URI path only).
  ['/home/xiao', ['.bun', 'proj']],
  ['/home/xiao/.bun', ['bin']],
  ['/home/xiao/proj', []],
])
const FILES = new Set<string>(['/a/readme.md', '/a/notes.txt', '/a/pic.png', '/a/src/code.ts'])

class FakeFileService implements Partial<IFileService> {
  declare readonly _serviceBrand: undefined

  readonly createdDirs: string[] = []
  readonly writtenFiles: string[] = []

  async list(resource: URI): Promise<IDirectoryEntry[]> {
    const names = DIRS.get(resource.path)
    if (!names) throw new Error(`ENOENT ${resource.path}`)
    return names.map((name) => {
      const childPath = resource.path === '/' ? `/${name}` : `${resource.path}/${name}`
      return { name, isDirectory: DIRS.has(childPath), isFile: FILES.has(childPath) }
    })
  }

  async stat(resource: URI): Promise<IFileStat> {
    const p = resource.path
    if (DIRS.has(p)) {
      return { resource, isDirectory: true, isFile: false, size: 0, mtime: 0 }
    }
    if (FILES.has(p)) {
      return { resource, isDirectory: false, isFile: true, size: 0, mtime: 0 }
    }
    throw new Error(`ENOENT ${p}`)
  }

  async exists(resource: URI): Promise<boolean> {
    return DIRS.has(resource.path) || FILES.has(resource.path)
  }

  async createDirectory(resource: URI): Promise<void> {
    this.createdDirs.push(resource.path)
  }

  async writeFile(resource: URI): Promise<void> {
    this.writtenFiles.push(resource.path)
  }
}

// Windows fake: drive-aware filesystem keyed by URI path (`/C:/...`), plus a
// `listDrives` enumeration of the available drive roots.
const WIN_DIRS = new Map<string, string[]>([
  ['/C:/', ['Users', 'Windows']],
  ['/C:/Users', ['u', 'Public']],
  ['/C:/Users/u', ['Documents']],
  ['/C:/Users/u/Documents', []],
  ['/C:/Users/Public', []],
  ['/C:/Windows', []],
  ['/D:/', ['data', 'projects']],
  ['/D:/data', []],
  ['/D:/projects', []],
  ['/F:/', ['backups']],
  ['/F:/backups', []],
])

class WinFakeFileService implements Partial<IFileService> {
  declare readonly _serviceBrand: undefined

  async list(resource: URI): Promise<IDirectoryEntry[]> {
    const names = WIN_DIRS.get(resource.path)
    if (!names) throw new Error(`ENOENT ${resource.path}`)
    const base = resource.path.endsWith('/') ? resource.path.slice(0, -1) : resource.path
    return names.map((name) => {
      const childPath = `${base}/${name}`
      return { name, isDirectory: WIN_DIRS.has(childPath), isFile: false }
    })
  }

  async stat(resource: URI): Promise<IFileStat> {
    if (WIN_DIRS.has(resource.path)) {
      return { resource, isDirectory: true, isFile: false, size: 0, mtime: 0 }
    }
    throw new Error(`ENOENT ${resource.path}`)
  }

  async exists(resource: URI): Promise<boolean> {
    return WIN_DIRS.has(resource.path)
  }

  async listDrives(): Promise<string[]> {
    return ['C:', 'D:', 'F:']
  }
}

const fakeWorkspace = { current: undefined } as unknown as IWorkspaceService
const fakeDialog = {
  confirm: async () => ({ confirmed: true }),
} as unknown as IDialogService

// In-memory storage so showDotFiles can persist across dialog opens in a test.
class FakeStorageService {
  private readonly _map = new Map<string, unknown>()
  async get<T>(key: string): Promise<T | undefined> {
    return this._map.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this._map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this._map.delete(key)
  }
  readonly onDidChangeWorkspaceScope = () => ({ dispose: () => undefined })
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const fakeLoggerService = {
  createLogger: () => new NullLogger(),
} as unknown as ILoggerService

class FakeConfigService {
  constructor(public nativeDialogEnabled = false) {}
  get<T>(key: string): T | undefined {
    if (key === 'files.nativeDialog.enable') return this.nativeDialogEnabled as T
    return undefined
  }
}

class FakeHostService {
  openCalls: IShowOpenFileOptions[] = []
  saveCalls: IShowSaveFileOptions[] = []
  openResult: UriComponents[] | null = null
  saveResult: UriComponents | null = null

  async showOpenFileDialog(opts?: IShowOpenFileOptions) {
    this.openCalls.push(opts ?? {})
    return this.openResult
  }
  async showSaveFileDialog(opts?: IShowSaveFileOptions) {
    this.saveCalls.push(opts ?? {})
    return this.saveResult
  }
}

function createDialog(
  storage: FakeStorageService = new FakeStorageService(),
  dialogService: IDialogService = fakeDialog,
  config: FakeConfigService = new FakeConfigService(),
  host: FakeHostService = new FakeHostService(),
): {
  dialog: SimpleFileDialog
  quickInput: FakeQuickInputService
  storage: FakeStorageService
  fileService: FakeFileService
  host: FakeHostService
} {
  const quickInput = new FakeQuickInputService()
  const fileService = new FakeFileService()
  const dialog = new SimpleFileDialog(
    quickInput as never,
    fileService as never,
    fakeWorkspace,
    dialogService,
    storage as never,
    config as unknown as IConfigurationService,
    host as unknown as IHostService,
    fakeLoggerService,
    { getEnvironment: async () => null } as never,
  )
  return { dialog, quickInput, storage, fileService, host }
}

const labels = (qp: FakeQuickPick): string[] => qp.items.map((it) => it.label)

const itemByLabel = (qp: FakeQuickPick, label: string): IQuickPickItem =>
  qp.items.find((it) => it.label === label)!

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    ipc: { platform: 'linux', home: '/home/u' },
  }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('SimpleFileDialog interaction', () => {
  it('initialises the list and input to the start folder', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick
    expect(qp.value).toBe('/a/')
    // folder-only picker drops files; `..` + the two subfolders remain
    expect(labels(qp)).toEqual(['..', 'git_project', 'src'])
  })

  it('[A] syncs the listing when the typed directory part changes', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/b/')
    await flush()

    expect(labels(qp)).toEqual(['..', 'foo'])
    // the input the user typed must not be clobbered back to the old folder
    expect(qp.value).toBe('/b/')
  })

  it('[B] highlights the entry whose name prefixes the typed segment', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/gi')
    await flush()

    expect(qp.activeItems.map((it) => it.label)).toEqual(['git_project'])
  })

  it('[B] clears the highlight while the user is deleting', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/git')
    await flush()
    expect(qp.activeItems).toHaveLength(1)

    qp.type('/a/gi') // backspace
    await flush()
    expect(qp.activeItems).toHaveLength(0)
  })

  it('[C] autocompletes the value to the active item and selects the untyped tail', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/gi')
    await flush()
    const match = qp.activeItems[0]!
    qp.fireActive(match)

    expect(qp.value).toBe('/a/git_project')
    // selection covers everything after the typed "gi"
    expect(qp.valueSelection).toEqual([5, '/a/git_project'.length])
  })

  it('[C] entering a highlighted directory appends a trailing separator', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/gi')
    await flush()
    qp.accept()
    await flush()

    expect(qp.value).toBe('/a/git_project/')
    expect(labels(qp)).toEqual(['..'])
  })

  it('[D] accepting a trailing-separator path opens that folder', async () => {
    const { dialog, quickInput } = createDialog()
    const result = dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/b/')
    await flush()
    qp.accept()

    const picked = await result
    expect(picked?.[0]?.path).toBe('/b')
  })

  it('[D] the OK button opens the trailing-separator folder too', async () => {
    const { dialog, quickInput } = createDialog()
    const result = dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.triggerOk()

    const picked = await result
    expect(picked?.[0]?.path).toBe('/a')
  })

  it('expands a leading ~ to the home directory and lists it', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('~')
    await flush()

    expect(qp.value).toBe('/home/u/')
    expect(labels(qp)).toEqual(['..', 'Documents'])
  })

  it('clears the pending completion selection once the typed segment stops matching', async () => {
    // Regression: after autocompleting "/a/git_project" (tail selected), typing a
    // further char that no longer matches must drop valueSelection, or the panel
    // re-selects the just-typed char and the next keystroke replaces it (the
    // "can only type one character past an existing path" bug).
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/gi')
    await flush()
    expect(qp.valueSelection).toBeDefined()

    // user keeps typing a path segment that doesn't exist yet
    qp.type('/a/gitx')
    await flush()
    expect(qp.activeItems).toHaveLength(0)
    expect(qp.valueSelection).toBeUndefined()
  })

  it('offers to create a non-existent folder on accept and returns it', async () => {
    const dialogService = {
      confirm: async () => ({ confirmed: true }),
    } as unknown as IDialogService
    const { dialog, quickInput, fileService } = createDialog(
      new FakeStorageService(),
      dialogService,
    )
    const result = dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/newdir')
    await flush()
    qp.triggerOk()

    const picked = await result
    expect(picked?.[0]?.path).toBe('/a/newdir')
    expect(fileService.createdDirs).toContain('/a/newdir')
  })

  it('does not create the path when the user declines the confirmation', async () => {
    const dialogService = {
      confirm: async () => ({ confirmed: false }),
    } as unknown as IDialogService
    const { dialog, quickInput, fileService } = createDialog(
      new FakeStorageService(),
      dialogService,
    )
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/newdir')
    await flush()
    qp.triggerOk()
    await flush()

    expect(fileService.createdDirs).toHaveLength(0)
  })

  it('shows only one create confirmation when accept fires repeatedly', async () => {
    let confirmCalls = 0
    let release!: (r: { confirmed: boolean }) => void
    const dialogService = {
      confirm: () => {
        confirmCalls++
        return new Promise<{ confirmed: boolean }>((r) => {
          release = r
        })
      },
    } as unknown as IDialogService
    const { dialog, quickInput, fileService } = createDialog(
      new FakeStorageService(),
      dialogService,
    )
    const result = dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/newdir')
    await flush()
    // Two rapid accepts while the first confirm is still pending.
    qp.triggerOk()
    qp.triggerOk()
    await flush()
    expect(confirmCalls).toBe(1)

    release({ confirmed: true })
    const picked = await result
    expect(picked?.[0]?.path).toBe('/a/newdir')
    expect(fileService.createdDirs).toEqual(['/a/newdir'])
  })

  it('offers to create a non-existent file (with missing parents) in a file picker', async () => {
    const dialogService = {
      confirm: async () => ({ confirmed: true }),
    } as unknown as IDialogService
    const { dialog, quickInput, fileService } = createDialog(
      new FakeStorageService(),
      dialogService,
    )
    const result = dialog.showOpenDialog({
      title: 'Open File',
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/sub/note.txt')
    await flush()
    qp.triggerOk()

    const picked = await result
    expect(picked?.[0]?.path).toBe('/a/sub/note.txt')
    expect(fileService.createdDirs).toContain('/a/sub')
    expect(fileService.writtenFiles).toContain('/a/sub/note.txt')
  })

  it('toggling hidden files reveals dotfiles and persists the setting across opens', async () => {
    const storage = new FakeStorageService()
    const first = createDialog(storage)
    void first.dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp1 = first.quickInput.lastPick
    // hidden by default
    expect(labels(qp1)).toEqual(['..', 'git_project', 'src'])

    qp1.triggerButton()
    await flush()
    // ".hidden" now shows (directories first, sorted)
    expect(labels(qp1)).toEqual(['..', '.hidden', 'git_project', 'src'])

    // A fresh dialog sharing the same storage must remember the setting.
    const second = createDialog(storage)
    void second.dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    expect(labels(second.quickInput.lastPick)).toEqual(['..', '.hidden', 'git_project', 'src'])
  })
})

describe('SimpleFileDialog multi-select', () => {
  it('sets canSelectMany on the pick and lists files for checking', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Files',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick
    expect(qp.canSelectMany).toBe(true)
    expect(labels(qp)).toEqual(['..', 'git_project', 'src', 'notes.txt', 'pic.png', 'readme.md'])
  })

  it('accepting a file toggles its checkbox instead of closing; OK confirms the set', async () => {
    const { dialog, quickInput } = createDialog()
    const result = dialog.showOpenDialog({
      title: 'Open Files',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.activeItems = [itemByLabel(qp, 'notes.txt')]
    qp.accept()
    await flush()
    expect(qp.selectedItems.map((it) => it.label)).toEqual(['notes.txt'])

    qp.activeItems = [itemByLabel(qp, 'readme.md')]
    qp.accept()
    await flush()
    expect(qp.selectedItems.map((it) => it.label)).toEqual(['notes.txt', 'readme.md'])

    qp.triggerOk()
    const picked = await result
    expect(picked?.map((u) => u.path)).toEqual(['/a/notes.txt', '/a/readme.md'])
  })

  it('accepting a checked file again deselects it', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Files',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.activeItems = [itemByLabel(qp, 'notes.txt')]
    qp.accept()
    await flush()
    expect(qp.selectedItems).toHaveLength(1)

    qp.accept()
    await flush()
    expect(qp.selectedItems).toHaveLength(0)
  })

  it('OK with an empty checked set falls back to the typed path (single pick)', async () => {
    const { dialog, quickInput } = createDialog()
    const result = dialog.showOpenDialog({
      title: 'Open Files',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.type('/a/notes.txt')
    await flush()
    qp.triggerOk()

    const picked = await result
    expect(picked?.map((u) => u.path)).toEqual(['/a/notes.txt'])
  })

  it('accepting a folder still navigates into it in multi-select mode', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Files',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.activeItems = [itemByLabel(qp, 'src')]
    qp.accept()
    await flush()

    expect(qp.value).toBe('/a/src/')
    expect(labels(qp)).toEqual(['..', 'code.ts'])
  })

  it('keeps picks recorded in a previously visited folder (checkbox proposal)', async () => {
    const { dialog, quickInput } = createDialog()
    const result = dialog.showOpenDialog({
      title: 'Open Files',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    // Check notes.txt in /a, then navigate into src/.
    qp.activeItems = [itemByLabel(qp, 'notes.txt')]
    qp.accept()
    await flush()
    qp.activeItems = [itemByLabel(qp, 'src')]
    qp.accept()
    await flush()
    expect(qp.value).toBe('/a/src/')

    // The panel proposes the carried snapshot plus the newly checked row.
    qp.fireSelection([...qp.selectedItems, itemByLabel(qp, 'code.ts')])
    await flush()
    expect(qp.selectedItems.map((it) => it.label)).toEqual(['notes.txt', 'code.ts'])

    qp.triggerOk()
    const picked = await result
    expect(picked?.map((u) => u.path)).toEqual(['/a/notes.txt', '/a/src/code.ts'])
  })

  it('drops non-selectable rows from a checkbox proposal', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Files',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    // '..' and folders are not pickable in a files-only picker.
    qp.fireSelection([itemByLabel(qp, '..'), itemByLabel(qp, 'src'), itemByLabel(qp, 'notes.txt')])
    await flush()
    expect(qp.selectedItems.map((it) => it.label)).toEqual(['notes.txt'])
  })
})

describe('SimpleFileDialog filters', () => {
  const textFilters = [{ name: 'Text', extensions: ['txt', 'md'] }]

  it('lists only files matching the filter groups; folders stay visible', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open File',
      canSelectFiles: true,
      canSelectFolders: false,
      filters: textFilters,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick
    expect(labels(qp)).toEqual(['..', 'git_project', 'src', 'notes.txt', 'readme.md'])
  })

  it('a `*` group disables filtering', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open File',
      canSelectFiles: true,
      canSelectFolders: false,
      filters: [{ name: 'All Files', extensions: ['*'] }],
      defaultUri: URI.file('/a'),
    })
    await flush()
    expect(labels(quickInput.lastPick)).toEqual([
      '..',
      'git_project',
      'src',
      'notes.txt',
      'pic.png',
      'readme.md',
    ])
  })

  it('rejects a typed path whose extension is outside the filter', async () => {
    const { dialog, quickInput } = createDialog()
    const result = dialog.showOpenDialog({
      title: 'Open File',
      canSelectFiles: true,
      canSelectFolders: false,
      filters: textFilters,
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    let settled: URI[] | undefined | 'pending' = 'pending'
    void result.then((r) => {
      settled = r
    })

    qp.type('/a/pic.png')
    await flush()
    qp.triggerOk()
    await flush()
    expect(settled).toBe('pending')

    qp.type('/a/notes.txt')
    await flush()
    qp.triggerOk()
    const picked = await result
    expect(picked?.map((u) => u.path)).toEqual(['/a/notes.txt'])
  })

  it('filters apply inside navigated subfolders too', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open File',
      canSelectFiles: true,
      canSelectFolders: false,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      defaultUri: URI.file('/a'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.activeItems = [itemByLabel(qp, 'src')]
    qp.accept()
    await flush()
    // code.ts is filtered out; only the parent row remains
    expect(labels(qp)).toEqual(['..'])
  })
})

describe('SimpleFileDialog native dialog branch', () => {
  const nativeConfig = (): FakeConfigService => new FakeConfigService(true)

  it('delegates open to the native host dialog when files.nativeDialog.enable=true', async () => {
    const host = new FakeHostService()
    host.openResult = [URI.file('/a/src').toJSON()]
    const { dialog, quickInput } = createDialog(
      new FakeStorageService(),
      fakeDialog,
      nativeConfig(),
      host,
    )
    const picked = await dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
      openLabel: 'Choose',
    })
    expect(quickInput.lastPick).toBeUndefined()
    expect(host.openCalls).toEqual([
      {
        title: 'Open Folder',
        defaultPath: '/a',
        canSelectFiles: false,
        canSelectFolders: true,
        buttonLabel: 'Choose',
      },
    ])
    expect(picked?.[0]?.fsPath).toBe('/a/src')
  })

  it('passes canSelectMany and filters through to the native host dialog', async () => {
    const host = new FakeHostService()
    host.openResult = [URI.file('/a/notes.txt').toJSON(), URI.file('/a/readme.md').toJSON()]
    const { dialog } = createDialog(new FakeStorageService(), fakeDialog, nativeConfig(), host)
    const picked = await dialog.showOpenDialog({
      title: 'Open',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: [{ name: 'Text', extensions: ['txt', 'md'] }],
    })
    expect(host.openCalls).toEqual([
      {
        title: 'Open',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        filters: [{ name: 'Text', extensions: ['txt', 'md'] }],
      },
    ])
    expect(picked?.map((u) => u.fsPath)).toEqual(['/a/notes.txt', '/a/readme.md'])
  })

  it('delegates save to the native host dialog when files.nativeDialog.enable=true', async () => {
    const host = new FakeHostService()
    host.saveResult = URI.file('/a/out.txt').toJSON()
    const { dialog } = createDialog(new FakeStorageService(), fakeDialog, nativeConfig(), host)
    const picked = await dialog.showSaveDialog({
      title: 'Save As',
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: URI.file('/a/out.txt'),
    })
    expect(host.saveCalls).toEqual([{ title: 'Save As', defaultPath: '/a/out.txt' }])
    expect(picked?.fsPath).toBe('/a/out.txt')
  })

  it('resolves undefined when the native dialog is cancelled', async () => {
    const host = new FakeHostService()
    const { dialog } = createDialog(new FakeStorageService(), fakeDialog, nativeConfig(), host)
    const picked = await dialog.showOpenDialog({
      title: 'Open File',
      canSelectFiles: true,
      canSelectFolders: false,
    })
    expect(picked).toBeUndefined()
  })

  it('keeps the QuickInput dialog when the setting is off', async () => {
    const host = new FakeHostService()
    const { dialog, quickInput } = createDialog(
      new FakeStorageService(),
      fakeDialog,
      new FakeConfigService(false),
      host,
    )
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/a'),
    })
    await flush()
    expect(host.openCalls).toEqual([])
    expect(quickInput.lastPick).toBeDefined()
  })
})

describe('SimpleFileDialog Windows drives', () => {
  const createWinDialog = (): { dialog: SimpleFileDialog; quickInput: FakeQuickInputService } => {
    const quickInput = new FakeQuickInputService()
    const dialog = new SimpleFileDialog(
      quickInput as never,
      new WinFakeFileService() as never,
      fakeWorkspace,
      fakeDialog,
      new FakeStorageService() as never,
      new FakeConfigService() as unknown as IConfigurationService,
      new FakeHostService() as unknown as IHostService,
      fakeLoggerService,
      { getEnvironment: async () => null } as never,
    )
    return { dialog, quickInput }
  }

  beforeEach(() => {
    ;(globalThis as { window?: unknown }).window = {
      ipc: { platform: 'win32', home: 'C:\\Users\\u' },
    }
  })

  const openAt = (uri: URI): { quickInput: FakeQuickInputService } => {
    const { dialog, quickInput } = createWinDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: uri,
    })
    return { quickInput }
  }

  it('initialises with a Windows drive path and backslash separators', async () => {
    const { quickInput } = openAt(URI.file('C:/Users/u'))
    await flush()
    const qp = quickInput.lastPick
    expect(qp.value).toBe('C:\\Users\\u\\')
    expect(labels(qp)).toEqual(['..', 'Documents'])
  })

  it('switches drives when a different drive letter is typed', async () => {
    const { quickInput } = openAt(URI.file('C:/Users/u'))
    await flush()
    const qp = quickInput.lastPick

    qp.type('D:\\')
    await flush()

    expect(labels(qp)).toEqual(['..', 'data', 'projects'])
    // the typed drive path must not be clobbered back to the previous folder
    expect(qp.value).toBe('D:\\')
  })

  it('lists all drives when the address bar is emptied', async () => {
    const { quickInput } = openAt(URI.file('C:/Users/u'))
    await flush()
    const qp = quickInput.lastPick

    qp.type('')
    await flush()

    expect(labels(qp)).toEqual(['C:', 'D:', 'F:'])
    expect(qp.value).toBe('')
  })

  it('enters a drive selected from the drive list', async () => {
    const { quickInput } = openAt(URI.file('C:/Users/u'))
    await flush()
    const qp = quickInput.lastPick

    qp.type('')
    await flush()
    const driveD = qp.items.find((it) => it.label === 'D:')!
    qp.activeItems = [driveD]
    qp.accept()
    await flush()

    expect(qp.value).toBe('D:\\')
    expect(labels(qp)).toEqual(['..', 'data', 'projects'])
  })

  it('navigates up from a drive root to the drive list', async () => {
    const { quickInput } = openAt(URI.file('D:/'))
    await flush()
    const qp = quickInput.lastPick
    expect(qp.value).toBe('D:\\')

    const parent = qp.items.find((it) => it.label === '..')!
    qp.activeItems = [parent]
    qp.accept()
    await flush()

    expect(labels(qp)).toEqual(['C:', 'D:', 'F:'])
    expect(qp.value).toBe('')
  })

  it('typing a bare segment shows drives, not a current-folder completion', async () => {
    // Select-all + type a single letter that matches a current-folder entry
    // ("Documents"). It must not autocomplete into "C:\Users\u\Documents";
    // instead the drive list appears and the matching drive (D:) is highlighted.
    const { quickInput } = openAt(URI.file('C:/Users/u'))
    await flush()
    const qp = quickInput.lastPick

    qp.type('d')
    await flush()

    expect(labels(qp)).toEqual(['C:', 'D:', 'F:'])
    expect(qp.activeItems.map((it) => it.label)).toEqual(['D:'])
    // the panel echoes the highlight back; it completes to the drive, not to
    // "C:\Users\u\Documents"
    qp.fireActive(qp.activeItems[0]!)
    expect(qp.value).toBe('D:')
  })

  it('typing a drive letter with no current-folder match still lists drives', async () => {
    const { quickInput } = openAt(URI.file('C:/Users/u'))
    await flush()
    const qp = quickInput.lastPick

    qp.type('f')
    await flush()

    expect(labels(qp)).toEqual(['C:', 'D:', 'F:'])
    expect(qp.activeItems.map((it) => it.label)).toEqual(['F:'])
    qp.fireActive(qp.activeItems[0]!)
    expect(qp.value).toBe('F:')
  })
})

describe('SimpleFileDialog remote target browsing', () => {
  const LINUX_ENV: RemoteEnvironmentDto = {
    os: 'linux',
    arch: 'x64',
    homeDir: '/home/xiao',
    tmpDir: '/tmp',
    pathCaseSensitive: true,
    serverVersion: '0.0.0',
  }

  const remoteUri = (path: string): URI =>
    URI.from({ scheme: REMOTE_SCHEME, authority: 'wsl+ubuntu2004', path })

  const createRemoteDialog = (
    env: RemoteEnvironmentDto | null = LINUX_ENV,
  ): { dialog: SimpleFileDialog; quickInput: FakeQuickInputService } => {
    const quickInput = new FakeQuickInputService()
    const dialog = new SimpleFileDialog(
      quickInput as never,
      new FakeFileService() as never,
      fakeWorkspace,
      fakeDialog,
      new FakeStorageService() as never,
      new FakeConfigService() as unknown as IConfigurationService,
      new FakeHostService() as unknown as IHostService,
      fakeLoggerService,
      { getEnvironment: async () => env } as never,
    )
    return { dialog, quickInput }
  }

  const openAt = async (
    uri: URI,
    env: RemoteEnvironmentDto | null = LINUX_ENV,
  ): Promise<FakeQuickPick> => {
    const { dialog, quickInput } = createRemoteDialog(env)
    void dialog.showOpenDialog({
      title: 'Open Folder on wsl+ubuntu2004',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: uri,
    })
    await flush()
    return quickInput.lastPick
  }

  beforeEach(() => {
    // Windows client browsing a Linux remote host.
    ;(globalThis as { window?: unknown }).window = {
      ipc: { platform: 'win32', home: 'C:\\Users\\xiao' },
    }
  })

  it('displays the remote path with the remote separator, not the client one', async () => {
    const qp = await openAt(remoteUri('/home/xiao'))

    expect(qp.value).toBe('/home/xiao/')
  })

  it('keeps the remote separator while navigating into a subfolder', async () => {
    const qp = await openAt(remoteUri('/home/xiao'))

    qp.activeItems = [itemByLabel(qp, 'proj')]
    qp.accept()
    await flush()

    expect(qp.value).toBe('/home/xiao/proj/')
  })

  it('typing a bare segment matches within the remote folder — not the local drive list', async () => {
    const qp = await openAt(remoteUri('/home/xiao'))

    qp.type('p')
    await flush()

    expect(labels(qp)).toEqual(['..', 'proj'])
    expect(qp.value).toBe('/home/xiao/proj')
  })

  it('expands ~ to the remote home directory', async () => {
    const qp = await openAt(remoteUri('/home/xiao'))

    qp.type('~')
    await flush()

    expect(qp.value).toBe('/home/xiao/')
  })

  it('falls back to POSIX separators when the remote environment is unknown', async () => {
    const qp = await openAt(remoteUri('/home/xiao'), null)

    expect(qp.value).toBe('/home/xiao/')
  })
})

describe('SimpleFileDialog empty remote window', () => {
  const REMOTE_ENV: RemoteEnvironmentDto = {
    os: 'linux',
    arch: 'x64',
    homeDir: '/home/xiao',
    tmpDir: '/tmp',
    pathCaseSensitive: true,
    serverVersion: '0.0.0',
  }

  const remoteUri = (path: string): URI =>
    URI.from({ scheme: REMOTE_SCHEME, authority: 'wsl+ubuntu2004', path })

  const createRemoteDialog = (
    remoteStatus: { getEnvironment: (authority: string) => Promise<RemoteEnvironmentDto | null> },
    config: FakeConfigService = new FakeConfigService(),
    host: FakeHostService = new FakeHostService(),
  ): { dialog: SimpleFileDialog; quickInput: FakeQuickInputService; host: FakeHostService } => {
    const quickInput = new FakeQuickInputService()
    const dialog = new SimpleFileDialog(
      quickInput as never,
      new FakeFileService() as never,
      fakeWorkspace,
      fakeDialog,
      new FakeStorageService() as never,
      config as unknown as IConfigurationService,
      host as unknown as IHostService,
      fakeLoggerService,
      remoteStatus as never,
    )
    return { dialog, quickInput, host }
  }

  beforeEach(() => {
    // Empty remote window: no workspace folder, but the argv carries the
    // remote-ssh authority (mirrors `--ue-remote-authority=` on a New Window).
    ;(globalThis as { window?: unknown }).window = {
      ipc: { platform: 'linux', home: '/home/u', remoteAuthority: 'wsl+ubuntu2004' },
    }
  })

  it('starts in the remote home for an empty remote window', async () => {
    const { dialog, quickInput } = createRemoteDialog({ getEnvironment: async () => REMOTE_ENV })
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
    })
    await flush()
    const qp = quickInput.lastPick
    expect(qp.value).toBe('/home/xiao/')
    expect(labels(qp)).toEqual(['..', 'proj'])
  })

  it('falls back to the local home when the remote environment cannot be resolved', async () => {
    const { dialog, quickInput } = createRemoteDialog({
      getEnvironment: async () => {
        throw new Error('not connected')
      },
    })
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
    })
    await flush()
    const qp = quickInput.lastPick
    expect(qp.value).toBe('/home/u/')
    expect(labels(qp)).toEqual(['..', 'Documents'])
  })

  it('keeps the simple dialog for a remote defaultUri when the native dialog is enabled', async () => {
    const host = new FakeHostService()
    const { dialog, quickInput } = createRemoteDialog(
      { getEnvironment: async () => REMOTE_ENV },
      new FakeConfigService(true),
      host,
    )
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: remoteUri('/home/xiao'),
    })
    await flush()
    expect(host.openCalls).toEqual([])
    expect(quickInput.lastPick).toBeDefined()
    expect(quickInput.lastPick.value).toBe('/home/xiao/')
  })

  it('keeps the simple dialog for an empty remote window when the native dialog is enabled', async () => {
    const host = new FakeHostService()
    const { dialog, quickInput } = createRemoteDialog(
      { getEnvironment: async () => REMOTE_ENV },
      new FakeConfigService(true),
      host,
    )
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
    })
    await flush()
    expect(host.openCalls).toEqual([])
    expect(quickInput.lastPick).toBeDefined()
    expect(quickInput.lastPick.value).toBe('/home/xiao/')
  })
})
