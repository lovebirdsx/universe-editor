/*---------------------------------------------------------------------------------------------
 *  ExplorerView.visibleHints — the viewport-driven SCM query wiring.
 *
 *  Rows render from caches only; the queries themselves are driven by the row
 *  window <Tree> reports. These tests pin the wiring end to end: a zero-height
 *  tree probes nothing (while rows still render), a laid-out tree probes exactly
 *  the rows its viewport covers (±5 rows of slack), scrolling moves the probe, a
 *  collapsed subtree is never a candidate, and a version bump re-declares the
 *  same window so answers dropped under a stationary window get re-asked.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
import { ScrollStateCache } from '@universe-editor/workbench-ui'
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
import { IFocusScopeService } from '../../../services/focus/FocusScopeService.js'
import { FakeFocusScopeService } from '../../../services/focus/testing/fakeFocusScopeService.js'
import {
  IScmBehindHintService,
  type IScmBehindHintService as IBehindHints,
} from '../../../services/scm/ScmBehindHintService.js'
import {
  IScmDecorationsService,
  type IScmDecorationsService as IDecorationsService,
  type IScmDecorationsSnapshot,
} from '../../../services/scm/ScmDecorationsService.js'
import {
  IScmIgnoredResourcesService,
  type IScmIgnoredResourcesService as IIgnoredResources,
} from '../../../services/scm/ScmIgnoredResourcesService.js'
import {
  IScmWorkingTreeHintService,
  type IWorkingTreeHint,
  type IScmWorkingTreeHintService as IWorkingTreeHints,
} from '../../../services/scm/ScmWorkingTreeHintService.js'

const ROW_HEIGHT = 22
const VIEWPORT_ROWS = 3
/** Three rows on screen; mirrors Tree's own `VISIBLE_OVERSCAN`. */
const VIEWPORT = ROW_HEIGHT * VIEWPORT_ROWS
const OVERSCAN = 5

/** Stands in for all three on-demand SCM services; only the wiring is under test. */
class FakeScmHints {
  declare readonly _serviceBrand: undefined
  /** The writable handle the view subscribes to; a bump re-declares the window. */
  readonly version: ReturnType<typeof observableValue<number>>
  readonly markVisible = vi.fn()
  readonly getHint = vi.fn((_r: URI): IWorkingTreeHint | undefined => undefined)
  readonly getFolderHint = vi.fn((_r: URI): IWorkingTreeHint | undefined => undefined)
  readonly isBehind = vi.fn((_r: URI): boolean | undefined => undefined)
  readonly isIgnored = vi.fn((_r: URI): boolean | undefined => undefined)
  constructor(name: string) {
    this.version = observableValue<number>(name, 0)
  }
}

/** Minimal decorations service: only the snapshot observable drives the view. */
class FakeDecorations {
  declare readonly _serviceBrand: undefined
  readonly decorations: ReturnType<typeof observableValue<IScmDecorationsSnapshot>> =
    observableValue<IScmDecorationsSnapshot>('fake.decorations', {
      files: new Map(),
      folders: new Map(),
      supplementary: new Map(),
    })
  getFile() {
    return undefined
  }
  getFolder() {
    return undefined
  }
  getSupplementary() {
    return undefined
  }
}

function makeFs(initial: Record<string, IDirectoryEntry[]> = {}): IFileServiceType {
  const dirs = new Map(Object.entries(initial))
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileHead() {
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

const files = (count: number): IDirectoryEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    name: `f${String(i).padStart(2, '0')}.txt`,
    isFile: true,
    isDirectory: false,
  }))

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

class FakeCommand {
  declare readonly _serviceBrand: undefined
  registerCommand() {
    return { dispose() {} }
  }
  async executeCommand() {}
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

function renderView(opts: { fs: IFileServiceType }) {
  const services = new ServiceCollection()
  const dialog: IDialogServiceType = {
    _serviceBrand: undefined,
    confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
    prompt: async () => undefined,
  }
  services.set(IFileService, opts.fs)
  services.set(IFileWatcherService, makeNoopWatcher())
  services.set(IExcludeService, new FakeExcludeService())
  services.set(IFocusScopeService, new FakeFocusScopeService())
  services.set(IWorkspaceService, new FakeWorkspace(URI.file('/ws')))
  services.set(IEditorService, new FakeEditor() as unknown as IEditorService)
  services.set(ICommandService, new FakeCommand() as unknown as ICommandService)
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
  services.set(IEditorResolverService, inst.createInstance(EditorResolverService))
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

  const workingTree = new FakeScmHints('fake.workingTreeVersion')
  const behind = new FakeScmHints('fake.behindVersion')
  const ignored = new FakeScmHints('fake.ignoredVersion')
  services.set(IScmWorkingTreeHintService, workingTree as unknown as IWorkingTreeHints)
  services.set(IScmBehindHintService, behind as unknown as IBehindHints)
  services.set(IScmIgnoredResourcesService, ignored as unknown as IIgnoredResources)
  const decorations = new FakeDecorations()
  services.set(IScmDecorationsService, decorations as unknown as IDecorationsService)

  const result = render(
    <ServicesContext.Provider value={inst}>
      <ExplorerView />
    </ServicesContext.Provider>,
  )
  return { ...result, workingTree, behind, ignored, decorations }
}

afterEach(() => {
  cleanup()
  // The tree persists its scroll position in a module-level cache keyed by
  // `scrollStateKey` ('explorer'); a position left by one test would restore
  // into the next one and shift its viewport window.
  ScrollStateCache._resetForTests()
})

/** The first report is deferred a frame (it must read settled layout). */
const flushWindow = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

const treeScroller = (): HTMLElement => document.querySelector('[role="tree"]') as HTMLElement

/** happy-dom has no layout, so the viewport height is pinned by hand. */
async function layout(viewport: number): Promise<void> {
  Object.defineProperty(treeScroller(), 'clientHeight', { value: viewport, configurable: true })
  treeScroller().dispatchEvent(new Event('scroll'))
  await flushWindow()
}

async function scrollTo(top: number): Promise<void> {
  treeScroller().scrollTop = top
  treeScroller().dispatchEvent(new Event('scroll'))
  await flushWindow()
}

/** The resources declared by the most recent `markVisible` call (empty or not). */
const declared = (spy: ReturnType<typeof vi.fn>): string[] => {
  const last = spy.mock.calls.at(-1)?.[0] as readonly URI[] | undefined
  return last?.map((u) => u.path.split('/').pop() ?? '') ?? []
}

const declaredCallCount = (spy: ReturnType<typeof vi.fn>): number =>
  spy.mock.calls.filter((c) => (c[0] as readonly URI[]).length > 0).length

describe('ExplorerView — viewport-driven SCM queries', () => {
  it('probes nothing while the tree has no viewport, even though rows render', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({ [root.toString()]: files(3) })
    const { workingTree, behind, ignored } = renderView({ fs })

    await screen.findByText('f00.txt')
    await flushWindow()

    // Rows were drawn — the cache reads happened …
    expect(workingTree.getHint).toHaveBeenCalled()
    expect(ignored.isIgnored).toHaveBeenCalled()
    // … but a zero-height viewport covers no rows, so nothing may be probed.
    expect(declaredCallCount(workingTree.markVisible)).toBe(0)
    expect(declaredCallCount(behind.markVisible)).toBe(0)
    expect(declaredCallCount(ignored.markVisible)).toBe(0)
    // The behind probe is no longer driven from renderRow at all.
    expect(behind.isBehind).not.toHaveBeenCalled()
  })

  it('declares only the rows the viewport covers, not every rendered row', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({ [root.toString()]: files(30) })
    const { workingTree, behind, ignored } = renderView({ fs })

    await screen.findByText('f00.txt')
    await flushWindow()
    await layout(VIEWPORT)

    // Rows 0..2 are on screen; ±5 rows of slack gives f00..f06 (clamped at the
    // top), never f07 and beyond — 30 rows were rendered all the same.
    const expectedFiles = [
      'f00.txt',
      'f01.txt',
      'f02.txt',
      'f03.txt',
      'f04.txt',
      'f05.txt',
      'f06.txt',
    ]
    expect(declared(workingTree.markVisible)).toEqual(expectedFiles)
    expect(declared(behind.markVisible)).toEqual(expectedFiles)
    // Ignored is declared for files and the folder rows among them.
    expect(declared(ignored.markVisible)).toEqual(['ws', ...expectedFiles])
    expect(declared(ignored.markVisible)).toHaveLength(VIEWPORT_ROWS + OVERSCAN)
  })

  it('moves the probe with the viewport when it scrolls', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({ [root.toString()]: files(30) })
    const { workingTree } = renderView({ fs })

    await screen.findByText('f00.txt')
    await flushWindow()
    await layout(VIEWPORT)
    expect(declared(workingTree.markVisible)).toContain('f00.txt')

    // Ten rows down: rows 10..12 on screen, ±5 slack → f04..f16 (nodes 5..17).
    await scrollTo(ROW_HEIGHT * 10)

    expect(declared(workingTree.markVisible)).toEqual([
      'f04.txt',
      'f05.txt',
      'f06.txt',
      'f07.txt',
      'f08.txt',
      'f09.txt',
      'f10.txt',
      'f11.txt',
      'f12.txt',
      'f13.txt',
      'f14.txt',
      'f15.txt',
      'f16.txt',
    ])
  })

  it('never declares rows hidden inside a collapsed subtree', async () => {
    const root = URI.file('/ws')
    const src = URI.joinPath(root, 'src')
    const fs = makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [src.toString()]: files(3),
    })
    const { workingTree } = renderView({ fs })

    await screen.findByText('src')
    await flushWindow()
    await layout(VIEWPORT)
    expect(declared(workingTree.markVisible)).toEqual([])

    // Expanding puts the children into the visible rows, so they become
    // candidates; collapsing takes them out again.
    fireEvent.click(screen.getByText('src'))
    await screen.findByText('f00.txt')
    await flushWindow()
    expect(declared(workingTree.markVisible)).toEqual(['f00.txt', 'f01.txt', 'f02.txt'])

    fireEvent.click(screen.getByText('src'))
    await flushWindow()
    expect(declared(workingTree.markVisible)).toEqual([])
  })

  it('re-declares the window when the decorations snapshot changes', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({ [root.toString()]: files(30) })
    const { workingTree, decorations } = renderView({ fs })

    await screen.findByText('f00.txt')
    await flushWindow()
    await layout(VIEWPORT)
    const before = declaredCallCount(workingTree.markVisible)
    expect(before).toBeGreaterThan(0)

    // A provider refresh marks the whole working-tree cache stale *without*
    // bumping a version — the decorations observable is the only signal that
    // path has, so this dependency is load-bearing: without it, a p4 collect
    // would never re-probe the rows.
    await act(async () => {
      decorations.decorations.set(
        { files: new Map(), folders: new Map(), supplementary: new Map() },
        undefined,
      )
    })

    expect(declaredCallCount(workingTree.markVisible)).toBe(before + 1)
  })

  it('re-declares the same window when a version observable bumps', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({ [root.toString()]: files(30) })
    const { workingTree, behind, ignored } = renderView({ fs })

    await screen.findByText('f00.txt')
    await flushWindow()
    await layout(VIEWPORT)
    const before = declaredCallCount(workingTree.markVisible)
    expect(before).toBeGreaterThan(0)

    // An answer dropped under a stationary window (a save, an ignore-rule edit,
    // an invalidation) bumps the version so the window is re-declared — nothing
    // else would, as nothing scrolled.
    await act(async () => {
      workingTree.version.set(workingTree.version.get() + 1, undefined)
      behind.version.set(behind.version.get() + 1, undefined)
      ignored.version.set(ignored.version.get() + 1, undefined)
    })

    expect(declaredCallCount(workingTree.markVisible)).toBe(before + 1)
    expect(declared(workingTree.markVisible)).toEqual([
      'f00.txt',
      'f01.txt',
      'f02.txt',
      'f03.txt',
      'f04.txt',
      'f05.txt',
      'f06.txt',
    ])
  })
})
