/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WorkspaceRestoreContribution — at BlockRestore, hydrate editor groups from
 *  IStorageService; thereafter, persist groups on every change.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  IStorageService,
  IWorkspaceService,
  NullLogger,
  StorageScope,
  type IDisposable,
  type IEditorGroup,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  EditorGroupsService,
  type ISerializedEditorGroupsState,
} from '../services/editor/EditorGroupsService.js'

export const WORKSPACE_STATE_STORAGE_KEY = 'workbench.workspaceState'

const PERSIST_DEBOUNCE_MS = 200

interface PersistedWorkspaceState {
  readonly groups: ISerializedEditorGroupsState
}

export class WorkspaceRestoreContribution extends Disposable implements IWorkbenchContribution {
  private _persistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly _groupListeners = new Map<number, IDisposable>()
  private readonly _editorListeners = new Map<string, IDisposable>()
  private readonly _logger: ILogger
  // Suspend persistence while we're rebuilding the grid for a different
  // workspace — otherwise the group change events fired during clearAll/
  // restore would schedule a write back into the new workspace's storage,
  // overwriting it with the prior workspace's state.
  private _suspendPersist = false

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IWorkspaceService _workspace: IWorkspaceService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'workspaceRestore', name: 'Workspace Restore' }) ??
      new NullLogger()

    // Restore prior session synchronously enough that React mount sees the
    // rebuilt grid. We launch the read immediately; the lifecycle phase
    // (BlockRestore) is awaited by ContributionService.
    void this._restore()

    // Re-hydrate when the workspace storage scope swaps (folder open/close/change).
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        void this._restore()
      }),
    )

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
    const sub1 = group.onDidChangeModel(() => {
      this._syncEditorListeners()
      this._schedulePersist()
    })
    const sub2 = group.onDidActiveEditorChange(() => this._schedulePersist())
    this._groupListeners.set(group.id, {
      dispose: () => {
        sub1.dispose()
        sub2.dispose()
      },
    })
    this._syncEditorListeners()
  }

  private _syncEditorListeners(): void {
    const current = new Set<string>()
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        current.add(editor.id)
        if (!this._editorListeners.has(editor.id)) {
          this._editorListeners.set(
            editor.id,
            editor.onDidChangeDirty(() => this._schedulePersist()),
          )
        }
      }
    }
    for (const [id, sub] of this._editorListeners) {
      if (!current.has(id)) {
        sub.dispose()
        this._editorListeners.delete(id)
      }
    }
  }

  private async _restore(): Promise<void> {
    if (this._persistTimer !== null) {
      clearTimeout(this._persistTimer)
      this._persistTimer = null
    }
    this._suspendPersist = true
    try {
      const raw = await this._storage.get<PersistedWorkspaceState>(
        WORKSPACE_STATE_STORAGE_KEY,
        StorageScope.WORKSPACE,
      )
      if (!raw || !raw.groups) {
        // No state for this workspace (or no workspace open) — tear down to a
        // single empty group so the previous workspace's editors don't leak.
        ;(this._groups as EditorGroupsService).clearAll()
        this._logger.debug('cleared workspace state (no persisted data)')
        return
      }
      this._instantiation.invokeFunction((accessor) => {
        ;(this._groups as EditorGroupsService).restore(raw.groups, accessor)
      })
      this._logger.debug(
        `restored workspace state groups=${(this._groups as EditorGroupsService).groups.length}`,
      )
    } catch (err) {
      this._logger.warn(
        'failed to restore workspace state',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    } finally {
      this._suspendPersist = false
    }
  }

  private _schedulePersist(): void {
    if (this._suspendPersist) return
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
      await this._storage.set(WORKSPACE_STATE_STORAGE_KEY, state, StorageScope.WORKSPACE)
      this._logger.debug(`persisted workspace state groups=${this._groups.groups.length}`)
    } catch (err) {
      this._logger.warn(
        'failed to persist workspace state',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    }
  }

  override dispose(): void {
    if (this._persistTimer !== null) clearTimeout(this._persistTimer)
    for (const sub of this._groupListeners.values()) sub.dispose()
    this._groupListeners.clear()
    for (const sub of this._editorListeners.values()) sub.dispose()
    this._editorListeners.clear()
    super.dispose()
  }
}
