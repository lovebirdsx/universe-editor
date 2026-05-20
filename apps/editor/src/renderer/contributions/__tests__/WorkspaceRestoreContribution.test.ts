/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/WorkspaceRestoreContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  EditorRegistry,
  IEditorGroupsService,
  IFileService,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IDisposable,
  type IFileService as IFileServiceType,
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
  } as IFileServiceType
}

function makeStorage(initial: Record<string, unknown> = {}): IStorageService & {
  store: Record<string, unknown>
} {
  const store = { ...initial }
  return {
    _serviceBrand: undefined,
    store,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      store[key] = value
    },
  } as IStorageService & { store: Record<string, unknown> }
}

function makeWorkspaceStub(): IWorkspaceServiceType {
  return {
    _serviceBrand: undefined,
    current: null,
    onDidChangeWorkspace: new Emitter<IWorkspace | null>().event,
    recent: [] as readonly IRecentWorkspace[],
    onDidChangeRecent: new Emitter<readonly IRecentWorkspace[]>().event,
    async openFolder() {},
    async closeFolder() {},
    async clearRecent() {},
  } as IWorkspaceServiceType
}

function buildContribution(
  storage: IStorageService,
  groups: EditorGroupsService,
): { contribution: WorkspaceRestoreContribution; inst: InstantiationService } {
  const services = new ServiceCollection()
  services.set(IStorageService, storage)
  services.set(IEditorGroupsService, groups)
  services.set(IWorkspaceService, makeWorkspaceStub())
  services.set(IFileService, makeFs())
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(WorkspaceRestoreContribution)
  return { contribution, inst }
}

describe('WorkspaceRestoreContribution', () => {
  let providerDispose: (() => void) | undefined

  beforeEach(() => {
    const d = EditorRegistry.registerEditorProvider({
      typeId: WelcomeEditorInput.TYPE_ID,
      componentKey: 'welcome-test',
      deserialize: () => WelcomeEditorInput.deserialize(),
    })
    providerDispose = () => d.dispose()
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { contribution } = buildContribution(storage, groups)
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
    expect(groups.groups).toHaveLength(1)
    warn.mockRestore()
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
