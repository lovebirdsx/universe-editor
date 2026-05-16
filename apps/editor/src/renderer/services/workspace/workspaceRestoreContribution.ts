/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WorkspaceRestoreContribution — at BlockRestore, hydrate editor groups from
 *  IStorageService; thereafter, persist groups on every change.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IInstantiationService,
  IStorageService,
  IWorkspaceService,
  type IDisposable,
  type IEditorGroup,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  EditorGroupsService,
  type ISerializedEditorGroupsState,
} from '../../workbench/editor/EditorGroupsService.js'

export const WORKSPACE_STATE_STORAGE_KEY = 'workbench.workspaceState'

const PERSIST_DEBOUNCE_MS = 200

interface PersistedWorkspaceState {
  readonly groups: ISerializedEditorGroupsState
}

export class WorkspaceRestoreContribution extends Disposable implements IWorkbenchContribution {
  private _persistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly _groupListeners = new Map<number, IDisposable>()

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IWorkspaceService _workspace: IWorkspaceService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
  ) {
    super()

    // Restore prior session synchronously enough that React mount sees the
    // rebuilt grid. We launch the read immediately; the lifecycle phase
    // (BlockRestore) is awaited by ContributionService.
    void this._restore()

    // Persistence wiring — listen to coarse and fine-grained group changes.
    this._register(this._groups.onDidAddGroup((g) => this._attachGroup(g)))
    this._register(
      this._groups.onDidRemoveGroup((g) => {
        const sub = this._groupListeners.get(g.id)
        sub?.dispose()
        this._groupListeners.delete(g.id)
        this._schedulePersist()
      }),
    )
    this._register(this._groups.onDidMoveGroup(() => this._schedulePersist()))
    this._register(this._groups.onDidActiveGroupChange(() => this._schedulePersist()))

    for (const g of this._groups.groups) this._attachGroup(g)
    void _workspace // silence unused-import — reserved for later cross-state coupling
  }

  private _attachGroup(group: IEditorGroup): void {
    if (this._groupListeners.has(group.id)) return
    const sub1 = group.onDidChangeModel(() => this._schedulePersist())
    const sub2 = group.onDidActiveEditorChange(() => this._schedulePersist())
    this._groupListeners.set(group.id, {
      dispose: () => {
        sub1.dispose()
        sub2.dispose()
      },
    })
  }

  private async _restore(): Promise<void> {
    try {
      const raw = await this._storage.get<PersistedWorkspaceState>(WORKSPACE_STATE_STORAGE_KEY)
      if (!raw || !raw.groups) return
      this._instantiation.invokeFunction((accessor) => {
        ;(this._groups as EditorGroupsService).restore(raw.groups, accessor)
      })
    } catch (err) {
      console.warn('[WorkspaceRestoreContribution] failed to restore workspace state', err)
    }
  }

  private _schedulePersist(): void {
    if (this._persistTimer !== null) clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      void this._persist()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async _persist(): Promise<void> {
    try {
      const state: PersistedWorkspaceState = {
        groups: (this._groups as EditorGroupsService).toJSON(),
      }
      await this._storage.set(WORKSPACE_STATE_STORAGE_KEY, state)
    } catch (err) {
      console.warn('[WorkspaceRestoreContribution] failed to persist workspace state', err)
    }
  }

  override dispose(): void {
    if (this._persistTimer !== null) clearTimeout(this._persistTimer)
    for (const sub of this._groupListeners.values()) sub.dispose()
    this._groupListeners.clear()
    super.dispose()
  }
}
