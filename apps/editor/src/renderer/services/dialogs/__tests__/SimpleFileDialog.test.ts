/*---------------------------------------------------------------------------------------------
 *  Host-level tests for SimpleFileDialog: reproduce the VSCode keyboard-interaction
 *  parity bugs (A-D) and the `~` home expansion, driving a fake QuickPick + a fake
 *  in-memory IFileService. Renderer-node (no DOM).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import type {
  IDialogService,
  IDirectoryEntry,
  IFileService,
  IFileStat,
  IQuickPickItem,
  IWorkspaceService,
} from '@universe-editor/platform'
import { SimpleFileDialog } from '../SimpleFileDialog.js'

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
  busy = false
  buttons: readonly unknown[] = []
  filterExternally = false
  keepOpenOnAccept = false
  title: string | undefined
  okLabel: string | undefined

  private readonly _onAccept = new Emitter<IQuickPickItem[]>()
  private readonly _onChangeValue = new Emitter<string>()
  private readonly _onChangeActive = new Emitter<IQuickPickItem | undefined>()
  private readonly _onTriggerOk = new Emitter<void>()
  private readonly _onTriggerButton = new Emitter<unknown>()
  private readonly _onHide = new Emitter<void>()

  readonly onDidAccept = this._onAccept.event
  readonly onDidChangeValue = this._onChangeValue.event
  readonly onDidChangeActive = this._onChangeActive.event
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
  ['/a', ['git_project', 'src', 'readme.md']],
  ['/a/git_project', []],
  ['/a/src', []],
  ['/b', ['foo']],
  ['/b/foo', []],
  ['/home/u', ['Documents']],
  ['/home/u/Documents', []],
])
const FILES = new Set<string>(['/a/readme.md'])

class FakeFileService implements Partial<IFileService> {
  declare readonly _serviceBrand: undefined

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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function createDialog(): { dialog: SimpleFileDialog; quickInput: FakeQuickInputService } {
  const quickInput = new FakeQuickInputService()
  const dialog = new SimpleFileDialog(
    quickInput as never,
    new FakeFileService() as never,
    fakeWorkspace,
    fakeDialog,
  )
  return { dialog, quickInput }
}

const labels = (qp: FakeQuickPick): string[] => qp.items.map((it) => it.label)

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
    expect(picked?.path).toBe('/b')
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
    expect(picked?.path).toBe('/a')
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
})

describe('SimpleFileDialog Windows drives', () => {
  const createWinDialog = (): { dialog: SimpleFileDialog; quickInput: FakeQuickInputService } => {
    const quickInput = new FakeQuickInputService()
    const dialog = new SimpleFileDialog(
      quickInput as never,
      new WinFakeFileService() as never,
      fakeWorkspace,
      fakeDialog,
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
