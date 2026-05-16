/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/workspace/workspaceRestoreContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  EditorRegistry,
  IEditorGroupsService,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  EditorGroupsService,
  type ISerializedEditorGroupsState,
} from '../../../workbench/editor/EditorGroupsService.js'
import { WelcomeEditorInput } from '../../../workbench/editor/WelcomeEditorInput.js'
import {
  WORKSPACE_STATE_STORAGE_KEY,
  WorkspaceRestoreContribution,
} from '../workspaceRestoreContribution.js'

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
): { contribution: WorkspaceRestoreContribution } {
  const services = new ServiceCollection()
  services.set(IStorageService, storage)
  services.set(IEditorGroupsService, groups)
  services.set(IWorkspaceService, makeWorkspaceStub())
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(WorkspaceRestoreContribution)
  return { contribution }
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
