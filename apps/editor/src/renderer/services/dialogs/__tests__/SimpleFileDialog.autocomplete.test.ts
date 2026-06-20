/*---------------------------------------------------------------------------------------------
 *  Reproduces the "forward typing over an autocompleted selection collapses the
 *  input" bug. Unlike SimpleFileDialog.test.ts (which drives a bare FakeQuickPick),
 *  this models the real panel faithfully: typing replaces the selected tail, and
 *  setting activeItems fires onDidChangeActive deduped by item id (so re-matching
 *  the same entry does NOT re-fire). Renderer-node (no DOM).
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

// A QuickPick fake that mirrors the QuickInputPanel behaviour relevant to
// autocomplete: a controlled value + selection, selection-aware typing, and an
// activeItems setter that drives focus and fires onDidChangeActive deduped by id.
class PanelLikeQuickPick {
  private _value = ''
  private _selection: [number, number] | undefined
  private _items: readonly IQuickPickItem[] = []
  private _activeItems: readonly IQuickPickItem[] = []
  private _focusedId: string | undefined
  private _lastFiredId: string | undefined

  busy = false
  buttons: readonly unknown[] = []
  filterExternally = false
  keepOpenOnAccept = false
  autoFocusFirstItem = true
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

  get value(): string {
    return this._value
  }
  set value(v: string) {
    this._value = v
  }
  get valueSelection(): [number, number] | undefined {
    return this._selection
  }
  set valueSelection(v: [number, number] | undefined) {
    this._selection = v
  }
  get items(): readonly IQuickPickItem[] {
    return this._items
  }
  set items(v: readonly IQuickPickItem[]) {
    this._items = v
    // List changed: with autoFocusFirstItem=false the panel drops focus and the
    // dedup ref resets, so the next activeItems set always fires.
    this._focusedId = undefined
    this._lastFiredId = undefined
  }
  get activeItems(): readonly IQuickPickItem[] {
    return this._activeItems
  }
  set activeItems(v: readonly IQuickPickItem[]) {
    this._activeItems = v
    if (v.length > 0) {
      const id = v[0]!.id
      this._focusedId = id
      if (id !== this._lastFiredId) {
        this._lastFiredId = id
        this._onChangeActive.fire(v[0])
      }
    }
    // Empty: focus is retained and nothing fires (mirrors the panel).
  }

  show(): void {}
  hide(): void {}
  dispose(): void {}

  /** Simulate a keystroke: replace the current selection (or append) then fire. */
  typeChar(c: string): void {
    const v = this._value
    const s = this._selection
    const next = s ? v.slice(0, s[0]) + c + v.slice(s[1]) : v + c
    this._value = next
    this._selection = undefined
    this._onChangeValue.fire(next)
  }
}

class FakeQuickInputService {
  declare readonly _serviceBrand: undefined
  lastPick!: PanelLikeQuickPick
  createQuickPick(): PanelLikeQuickPick {
    this.lastPick = new PanelLikeQuickPick()
    return this.lastPick
  }
}

const DIRS = new Map<string, string[]>([
  ['/b', ['foo']],
  ['/b/foo', []],
])

class FakeFileService implements Partial<IFileService> {
  declare readonly _serviceBrand: undefined

  async list(resource: URI): Promise<IDirectoryEntry[]> {
    const names = DIRS.get(resource.path)
    if (!names) throw new Error(`ENOENT ${resource.path}`)
    return names.map((name) => {
      const childPath = resource.path === '/' ? `/${name}` : `${resource.path}/${name}`
      return { name, isDirectory: DIRS.has(childPath), isFile: false }
    })
  }

  async stat(resource: URI): Promise<IFileStat> {
    if (DIRS.has(resource.path)) {
      return { resource, isDirectory: true, isFile: false, size: 0, mtime: 0 }
    }
    throw new Error(`ENOENT ${resource.path}`)
  }

  async exists(resource: URI): Promise<boolean> {
    return DIRS.has(resource.path)
  }
}

const fakeWorkspace = { current: undefined } as unknown as IWorkspaceService
const fakeDialog = { confirm: async () => ({ confirmed: true }) } as unknown as IDialogService
const fakeStorage = {
  get: async () => undefined,
  set: async () => undefined,
  remove: async () => undefined,
  onDidChangeWorkspaceScope: () => ({ dispose: () => undefined }),
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function createDialog(): { dialog: SimpleFileDialog; quickInput: FakeQuickInputService } {
  const quickInput = new FakeQuickInputService()
  const dialog = new SimpleFileDialog(
    quickInput as never,
    new FakeFileService() as never,
    fakeWorkspace,
    fakeDialog,
    fakeStorage as never,
  )
  return { dialog, quickInput }
}

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = { ipc: { platform: 'linux', home: '/home/u' } }
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('SimpleFileDialog autocomplete vs. forward typing', () => {
  it('keeps the completion when typing the matched characters (f, o, o → foo)', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/b'),
    })
    await flush()
    const qp = quickInput.lastPick

    // Type "f": completes to "/b/foo" with the tail "oo" selected.
    qp.typeChar('f')
    await flush()
    expect(qp.value).toBe('/b/foo')
    expect(qp.valueSelection).toEqual([4, 6])

    // Type "o" over the selected "oo": must stay "/b/foo" (only the last "o"
    // selected now), NOT collapse to "/b/fo".
    qp.typeChar('o')
    await flush()
    expect(qp.value).toBe('/b/foo')
    expect(qp.valueSelection).toEqual([5, 6])

    // Type the final "o": fully typed, completion stable, nothing left selected.
    qp.typeChar('o')
    await flush()
    expect(qp.value).toBe('/b/foo')
    expect(qp.valueSelection).toEqual([6, 6])
  })

  it('still treats a real backspace over the selected tail as a deletion', async () => {
    const { dialog, quickInput } = createDialog()
    void dialog.showOpenDialog({
      title: 'Open Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: URI.file('/b'),
    })
    await flush()
    const qp = quickInput.lastPick

    qp.typeChar('f')
    await flush()
    expect(qp.value).toBe('/b/foo')

    // Backspace deletes the selected tail "oo", leaving "/b/f". Completion must
    // NOT re-add the tail, and nothing should be highlighted.
    qp.valueSelection = [4, 6]
    qp.value = '/b/foo'
    qp.value = '/b/f'
    ;(qp as unknown as { _onChangeValue: { fire(v: string): void } })._onChangeValue.fire('/b/f')
    await flush()
    expect(qp.value).toBe('/b/f')
    expect(qp.activeItems).toHaveLength(0)
  })
})
