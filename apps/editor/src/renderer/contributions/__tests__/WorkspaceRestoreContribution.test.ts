/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/WorkspaceRestoreContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  EditorInput,
  EditorRegistry,
  IEditorGroupsService,
  IFileService,
  ILoggerService,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  LogLevel,
  NullLogger,
  ServiceCollection,
  URI,
  type IDisposable,
  type IFileService as IFileServiceType,
  type ILogger,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  EditorGroupsService,
  type ISerializedEditorGroupsState,
} from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { WelcomeEditorInput } from '../../services/editor/WelcomeEditorInput.js'
import {
  WORKSPACE_STATE_STORAGE_KEY,
  WorkspaceRestoreContribution,
} from '../WorkspaceRestoreContribution.js'

function makeFs(): IFileServiceType {
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
      return true
    },
    async stat() {
      throw new Error('not implemented')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  } as IFileServiceType
}

function makeStorage(initial: Record<string, unknown> = {}): IStorageService & {
  store: Record<string, unknown>
  fireScopeChange: () => void
} {
  const store = { ...initial }
  const emitter = new Emitter<void>()
  return {
    _serviceBrand: undefined,
    store,
    onDidChangeWorkspaceScope: emitter.event,
    fireScopeChange: () => emitter.fire(),
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      store[key] = value
    },
    async remove(key: string): Promise<void> {
      delete store[key]
    },
  } as IStorageService & { store: Record<string, unknown>; fireScopeChange: () => void }
}

function makeWorkspaceStub(): IWorkspaceServiceType {
  return {
    _serviceBrand: undefined,
    current: null,
    onDidChangeWorkspace: new Emitter<IWorkspace | null>().event,
    recent: [] as readonly IRecentWorkspace[],
    onDidChangeRecent: new Emitter<readonly IRecentWorkspace[]>().event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {},
    async clearRecent() {},
    async removeRecent() {},
  } as IWorkspaceServiceType
}

function makeLogger(): ILogger {
  return {
    level: LogLevel.Info,
    onDidChangeLogLevel: Event.None,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }
}

function buildContribution(
  storage: IStorageService,
  groups: EditorGroupsService,
  logger: ILogger = new NullLogger(),
): { contribution: WorkspaceRestoreContribution; inst: InstantiationService } {
  const services = new ServiceCollection()
  services.set(IStorageService, storage)
  services.set(IEditorGroupsService, groups)
  services.set(IWorkspaceService, makeWorkspaceStub())
  services.set(IFileService, makeFs())
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => logger,
    setLevel: () => {},
    getLevel: () => LogLevel.Info,
  })
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(WorkspaceRestoreContribution)
  return { contribution, inst }
}

describe('WorkspaceRestoreContribution', () => {
  let providerDispose: (() => void) | undefined

  let swapTestSeq = 0

  // Distinct-identity inputs: WelcomeEditorInput instances all share one id
  // (resource-derived) and would collide under the model's matches() equality.
  class SwapTestInput extends EditorInput {
    static readonly TYPE_ID = 'swap-test'
    constructor(readonly path: string = `/${swapTestSeq++}`) {
      super()
    }
    get typeId(): string {
      return SwapTestInput.TYPE_ID
    }
    get resource(): URI {
      return URI.from({ scheme: 'swap-test', path: this.path })
    }
    getName(): string {
      return this.path
    }
    override serialize(): unknown {
      return { path: this.path }
    }
  }

  beforeEach(() => {
    swapTestSeq = 0
    const d = EditorRegistry.registerEditorProvider({
      typeId: WelcomeEditorInput.TYPE_ID,
      componentKey: 'welcome-test',
      deserialize: () => WelcomeEditorInput.deserialize(),
    })
    const d2 = EditorRegistry.registerEditorProvider({
      typeId: SwapTestInput.TYPE_ID,
      componentKey: 'swap-test',
      deserialize: (data) => new SwapTestInput((data as { path: string }).path),
    })
    providerDispose = () => {
      d.dispose()
      d2.dispose()
    }
  })

  afterEach(() => {
    providerDispose?.()
    providerDispose = undefined
    vi.useRealTimers()
  })

  it('does nothing when storage is empty (groups stay default)', async () => {
    const groups = new EditorGroupsService()
    const storage = makeStorage()
    const { contribution } = buildContribution(storage, groups)
    await Promise.resolve()
    await Promise.resolve()
    expect(groups.groups).toHaveLength(1)
    expect(groups.groups[0]?.count).toBe(0)
    contribution.dispose()
    groups.dispose()
  })

  it('restores serialized groups from storage on construction', async () => {
    const groups = new EditorGroupsService()
    // Seed storage with state containing one Welcome editor.
    const seed = new EditorGroupsService()
    seed.activeGroup.openEditor(new WelcomeEditorInput())
    const state: ISerializedEditorGroupsState = seed.toJSON()
    seed.dispose()
    const storage = makeStorage({ [WORKSPACE_STATE_STORAGE_KEY]: { groups: state } })

    const { contribution } = buildContribution(storage, groups)
    // restore is async; flush.
    await Promise.resolve()
    await Promise.resolve()

    expect(groups.groups).toHaveLength(1)
    expect(groups.groups[0]?.count).toBe(1)
    expect(groups.groups[0]?.activeEditor?.typeId).toBe(WelcomeEditorInput.TYPE_ID)
    contribution.dispose()
    groups.dispose()
  })

  it('warns and falls back to default when stored state is malformed', async () => {
    const groups = new EditorGroupsService()
    const storage = makeStorage({ [WORKSPACE_STATE_STORAGE_KEY]: { groups: 'garbage' } })
    const logger = makeLogger()
    const { contribution } = buildContribution(storage, groups, logger)
    await Promise.resolve()
    await Promise.resolve()
    expect(logger.warn).toHaveBeenCalled()
    expect(groups.groups).toHaveLength(1)
    contribution.dispose()
    groups.dispose()
  })

  it('persists groups (debounced) when editors change', async () => {
    vi.useFakeTimers()
    const groups = new EditorGroupsService()
    const storage = makeStorage()
    const setSpy = vi.spyOn(storage, 'set')
    const { contribution } = buildContribution(storage, groups)
    // Allow the initial restore microtasks to settle.
    await Promise.resolve()
    await Promise.resolve()
    setSpy.mockClear()

    groups.activeGroup.openEditor(new WelcomeEditorInput())
    vi.advanceTimersByTime(250)
    await Promise.resolve()
    await Promise.resolve()
    expect(setSpy).toHaveBeenCalled()
    expect(setSpy.mock.calls[0]?.[0]).toBe(WORKSPACE_STATE_STORAGE_KEY)
    contribution.dispose()
    groups.dispose()
  })

  it('reloads when the workspace scope changes', async () => {
    const groups = new EditorGroupsService()
    // Start with one editor open via seeded state.
    const seed = new EditorGroupsService()
    seed.activeGroup.openEditor(new WelcomeEditorInput())
    const initial: ISerializedEditorGroupsState = seed.toJSON()
    seed.dispose()
    const storage = makeStorage({ [WORKSPACE_STATE_STORAGE_KEY]: { groups: initial } })
    const { contribution } = buildContribution(storage, groups)
    // Flush initial restore.
    await Promise.resolve()
    await Promise.resolve()
    expect(groups.groups[0]?.count).toBe(1)

    // Simulate workspace switch to an unseeded scope — storage backend now
    // returns undefined; the contribution should clear the editors.
    delete storage.store[WORKSPACE_STATE_STORAGE_KEY]
    storage.fireScopeChange()
    await Promise.resolve()
    await Promise.resolve()
    expect(groups.groups).toHaveLength(1)
    expect(groups.groups[0]?.count).toBe(0)

    contribution.dispose()
    groups.dispose()
  })

  it('keeps an editor opened while a fresh-workspace restore read is in flight', async () => {
    // CI race (case 71): openFolder resolves, the e2e/user opens a file, and
    // only then does the scope-swap restore finish its storage read. With no
    // persisted state the restore used to clearAll() and wipe the just-opened
    // editor — activeEditorLanguageId stuck at '' forever.
    const groups = new EditorGroupsService()
    const storage = makeStorage()
    let resolveGet: ((v: unknown) => void) | undefined
    vi.spyOn(storage, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve
        }),
    )
    const { contribution } = buildContribution(storage, groups)

    // The boot/swap restore is parked on the deferred read. The editor opened
    // now belongs to the new workspace scope.
    const newcomer = new SwapTestInput()
    groups.activeGroup.openEditor(newcomer)

    resolveGet?.(undefined)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(groups.groups).toHaveLength(1)
    expect(groups.groups[0]?.count).toBe(1)
    expect(groups.groups[0]?.activeEditor).toBe(newcomer)
    contribution.dispose()
    groups.dispose()
  })

  it('closes outgoing-scope editors but keeps swap-window newcomers', async () => {
    const groups = new EditorGroupsService()
    const seed = new EditorGroupsService()
    seed.activeGroup.openEditor(new SwapTestInput())
    const initial: ISerializedEditorGroupsState = seed.toJSON()
    seed.dispose()
    const storage = makeStorage({ [WORKSPACE_STATE_STORAGE_KEY]: { groups: initial } })
    const { contribution } = buildContribution(storage, groups)
    await Promise.resolve()
    await Promise.resolve()
    expect(groups.groups[0]?.count).toBe(1)
    const restored = groups.groups[0]!.editors[0]!

    let resolveGet: ((v: unknown) => void) | undefined
    vi.spyOn(storage, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve
        }),
    )
    storage.fireScopeChange()
    const newcomer = new SwapTestInput()
    groups.activeGroup.openEditor(newcomer)

    resolveGet?.(undefined)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(groups.groups).toHaveLength(1)
    expect(groups.groups[0]?.contains(restored)).toBe(false)
    expect(groups.groups[0]?.contains(newcomer)).toBe(true)
    expect(groups.groups[0]?.activeEditor).toBe(newcomer)
    contribution.dispose()
    groups.dispose()
  })

  it('keeps swap-window newcomers on top of restored persisted state', async () => {
    const groups = new EditorGroupsService()
    const storage = makeStorage()
    const { contribution } = buildContribution(storage, groups)
    await Promise.resolve()
    await Promise.resolve()

    const seed = new EditorGroupsService()
    seed.activeGroup.openEditor(new SwapTestInput())
    const incoming: ISerializedEditorGroupsState = seed.toJSON()
    seed.dispose()

    let resolveGet: ((v: unknown) => void) | undefined
    vi.spyOn(storage, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve
        }),
    )
    storage.fireScopeChange()
    const newcomer = new SwapTestInput()
    groups.activeGroup.openEditor(newcomer)

    resolveGet?.({ groups: incoming })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(groups.groups).toHaveLength(1)
    expect(groups.groups[0]?.count).toBe(2)
    expect(groups.groups[0]?.contains(newcomer)).toBe(true)
    expect(groups.groups[0]?.activeEditor).toBe(newcomer)
    contribution.dispose()
    groups.dispose()
  })
})

// ---------------------------------------------------------------------------
// FileEditorInput provider registration timing
// ---------------------------------------------------------------------------

describe('WorkspaceRestoreContribution — FileEditorInput timing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeFileEditorState(): ISerializedEditorGroupsState {
    // Build state using a "source" EditorGroupsService, but do NOT register the
    // file provider via EditorRegistry. We manually construct the serialized
    // shape so the state is stable regardless of EditorRegistry state.
    return {
      grid: {
        root: {
          type: 'branch',
          size: 1,
          children: [
            {
              type: 'leaf',
              size: 1,
              data: {
                editors: [
                  {
                    typeId: FileEditorInput.TYPE_ID,
                    data: {
                      resource: {
                        scheme: 'file',
                        authority: '',
                        path: '/tmp/test-restore.json',
                        query: '',
                        fragment: '',
                      },
                    },
                  },
                ],
                activeIndex: 0,
              },
            },
          ],
        },
        orientation: 0,
        width: 800,
        height: 600,
      },
      activeGroupId: 0,
    }
  }

  it('silently skips FileEditorInput when its provider is absent at restore time', async () => {
    // Root cause of the bug: EditorArea.tsx registers the 'file' provider as a
    // module-level side-effect that only runs when the Workbench chunk loads
    // (await import('./workbench/Workbench.js')). That import happens AFTER
    // lifecycle.setPhase(Ready), so _restore() resolves before the provider
    // exists and every file editor is dropped silently.
    const groups = new EditorGroupsService()
    const state = makeFileEditorState()
    const storage = makeStorage({ [WORKSPACE_STATE_STORAGE_KEY]: { groups: state } })

    // Build the contribution WITHOUT registering the FileEditorInput provider.
    const { contribution } = buildContribution(storage, groups)
    await Promise.resolve()
    await Promise.resolve()

    // Provider absent → deserialise returns null → editor silently dropped.
    expect(groups.groups[0]?.count).toBe(0)
    contribution.dispose()
    groups.dispose()
  })

  it('restores FileEditorInput when its provider is registered before construction', async () => {
    // This is the correct behaviour after the fix: BuiltInEditorProvidersContribution
    // (BlockStartup) registers the provider synchronously before
    // WorkspaceRestoreContribution (BlockRestore) is constructed.
    const regDisposable: IDisposable = EditorRegistry.registerEditorProvider({
      typeId: FileEditorInput.TYPE_ID,
      componentKey: 'file',
      deserialize: (data, accessor) => FileEditorInput.deserialize(data, accessor),
    })

    try {
      const groups = new EditorGroupsService()
      const state = makeFileEditorState()
      const storage = makeStorage({ [WORKSPACE_STATE_STORAGE_KEY]: { groups: state } })

      const { contribution } = buildContribution(storage, groups)
      await Promise.resolve()
      await Promise.resolve()

      expect(groups.groups[0]?.count).toBe(1)
      expect(groups.groups[0]?.activeEditor?.typeId).toBe(FileEditorInput.TYPE_ID)
      expect(groups.groups[0]?.activeEditor?.resource?.toString()).toBe(
        URI.file('/tmp/test-restore.json').toString(),
      )
      contribution.dispose()
      groups.dispose()
    } finally {
      regDisposable.dispose()
    }
  })
})
