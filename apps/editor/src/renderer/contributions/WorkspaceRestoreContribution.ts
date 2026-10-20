/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WorkspaceRestoreContribution — at BlockRestore, hydrate editor groups from
 *  IStorageService; thereafter, persist groups on every change.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IInstantiationService,
  ILifecycleService,
  ILoggerService,
  IStorageService,
  IWorkspaceService,
  NullLogger,
  StorageScope,
  type ServiceIdentifier,
  type ServicesAccessor,
  type IDisposable,
  type EditorInput,
  type IEditorGroup,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  EditorGroupsService,
  type ISerializedEditorGroupsState,
} from '../services/editor/EditorGroupsService.js'
import { IRecentTargetsService } from '../services/editor/RecentTargetsService.js'
import {
  IAuxiliaryEditorWindowService,
  type ISerializedAuxiliaryWindowsState,
} from '../services/windows/auxiliaryEditorWindowService.js'
import { recordPerfPhaseAsync } from '../services/performance/perfPhases.js'

export const WORKSPACE_STATE_STORAGE_KEY = 'workbench.workspaceState'

const PERSIST_DEBOUNCE_MS = 200

interface PersistedWorkspaceState {
  readonly groups: ISerializedEditorGroupsState
  readonly auxiliaryWindows?: ISerializedAuxiliaryWindowsState
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
  /** Monotonic guard: a slow storage read from an older scope must not apply. */
  private _generation = 0
  private _restoreChain: Promise<void> = Promise.resolve()
  private _restoring = false
  /** Editors present before the current batch of queued restores began. */
  private _batchBaseline: Set<EditorInput> | undefined
  /**
   * Editors materialized by a restore. A later generation in the same batch
   * shares the batch baseline, so these would otherwise pass the
   * "not in baseline" test and be carried into the incoming workspace.
   */
  private readonly _restoreProduced = new WeakSet<EditorInput>()

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IAuxiliaryEditorWindowService private readonly _auxWindows: IAuxiliaryEditorWindowService,
    @ILifecycleService private readonly _lifecycle: ILifecycleService,
    @IRecentTargetsService private readonly _recentTargets: IRecentTargetsService,
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
    this._register(this._auxWindows.onDidChangeWindows(() => this._schedulePersist()))
    this._register(this._groups.onDidActivePartChange(() => this._schedulePersist()))

    // A window close/reload persists the exact snapshot (including auxiliary
    // windows) before the renderer dies; the debounce alone would lose it.
    this._register(
      this._lifecycle.onWillShutdown((e) => {
        // Persist the exact snapshot (including auxiliary windows), then freeze:
        // the renderer is going away and the main process is about to destroy
        // the auxiliary windows, whose close events must not write a new state.
        const flushed = this._flush().finally(() => {
          this._suspendPersist = true
        })
        e.join(flushed, 'editor workspace state')
      }),
    )

    for (const g of this._groups.groups) this._attachGroup(g)
    void _workspace // silence unused-import — reserved for later cross-state coupling
  }

  private _attachGroup(group: IEditorGroup): void {
    if (this._groupListeners.has(group.id)) return
    const sub1 = this._register(
      group.onDidChangeModel(() => {
        this._syncEditorListeners()
        this._schedulePersist()
      }),
    )
    const sub2 = this._register(group.onDidActiveEditorChange(() => this._schedulePersist()))
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
            this._register(editor.onDidChangeDirty(() => this._schedulePersist())),
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

  /**
   * Restores are serialized: a workspace scope swap during the async read or
   * auxiliary-window recreation must not race the previous generation (both
   * would call `discardAllWindows` with entries still being created). The
   * first restore starts synchronously; later ones chain behind it.
   */
  private _restore(): Promise<void> {
    const generation = ++this._generation
    // A workspace swap can fire several scope events; all queued restores share
    // the snapshot from before the first one. Editors opened while any of them
    // is reading therefore count as newcomers for the whole batch instead of
    // being re-classified as outgoing scope by a later generation.
    this._batchBaseline ??= new Set(this._groups.groups.flatMap((group) => group.editors))
    const baseline = this._batchBaseline
    const run = (): Promise<void> => this._restoreForGeneration(generation, baseline)
    const task = this._restoring ? this._restoreChain.then(run, run) : run()
    this._restoring = true
    this._restoreChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async _restoreForGeneration(
    generation: number,
    baseline: Set<EditorInput>,
  ): Promise<void> {
    // A newer scope already superseded this task; skip the storage read and any
    // teardown it would perform against the wrong grid.
    if (generation !== this._generation) return
    if (this._persistTimer !== null) {
      clearTimeout(this._persistTimer)
      this._persistTimer = null
    }
    this._suspendPersist = true
    const groups = this._groups as EditorGroupsService
    let newcomers: EditorInput[] = []
    let activeNewcomer: EditorInput | undefined
    /**
     * Hand newcomers back to the grid. They were detached before the outgoing
     * layout was torn down and must not stay ownerless across the auxiliary
     * restore awaits (a rejected/throwing restore would otherwise strand them).
     */
    const reattachNewcomers = (): void => {
      if (newcomers.length === 0) return
      if (generation !== this._generation) {
        // A newer scope owns the grid now; never force the old scope's
        // documents into it.
        newcomers = []
        return
      }
      const target = groups.activeGroup
      for (const editor of newcomers) {
        if (!editor.isDisposed) target.openEditor(editor, { activate: false })
      }
      if (activeNewcomer && !activeNewcomer.isDisposed && target.contains(activeNewcomer)) {
        target.setActive(activeNewcomer)
      }
      newcomers = []
    }
    try {
      const raw = await this._storage.get<PersistedWorkspaceState>(
        WORKSPACE_STATE_STORAGE_KEY,
        StorageScope.WORKSPACE,
      )
      if (generation !== this._generation) return
      // Editors opened after the swap belong to the incoming scope. Collect
      // them (and detach them from *every* part — including auxiliary windows)
      // before `discardAllWindows`, which disposes those parts and would take
      // the detached inputs with them. Editors from an earlier generation's
      // restore are outgoing scope even though the batch baseline predates
      // them.
      newcomers = this._collectEditors().filter(
        (e) => !baseline.has(e) && !this._restoreProduced.has(e),
      )
      activeNewcomer = newcomers.find((e) =>
        groups.groups.some((group) => group.activeEditor === e),
      )
      for (const group of groups.groups) {
        for (const editor of newcomers) group.detachEditor(editor)
      }
      // Auxiliary parts belong to the outgoing workspace; their windows must go
      // before `groups.restore` disposes the parts they point at.
      this._auxWindows.discardAllWindows()
      if (!raw || !raw.groups) {
        // No state for this workspace (or no workspace open) — tear down to a
        // single empty group so the previous workspace's editors don't leak.
        groups.clearAll()
        this._logger.debug('cleared workspace state (no persisted data)')
      } else {
        const beforeRestore = new Set(this._collectEditors())
        this._instantiation.invokeFunction((accessor) => {
          groups.restore(raw.groups, accessor)
        })
        this._markRestoreProduced(beforeRestore)
        this._logger.debug(`restored workspace state groups=${groups.groups.length}`)
      }
      // Synchronous hand-back, before awaiting auxiliary-window recreation.
      reattachNewcomers()
      if (raw?.auxiliaryWindows && raw.auxiliaryWindows.windows.length > 0) {
        const restoredEditors = await this._auxWindows.restore(
          raw.auxiliaryWindows,
          this._instantiationAccessor(),
        )
        // Mark before the generation check: the incoming generation (already
        // queued behind this task) must still know these editors are outgoing.
        for (const editor of restoredEditors) this._restoreProduced.add(editor)
        if (generation !== this._generation) return
      }
    } catch (err) {
      this._logger.warn(
        'failed to restore workspace state',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    } finally {
      // Exception path: restore the same ownership guarantee before the grid is
      // marked settled. A no-op when the try-block already reattached them.
      reattachNewcomers()
      if (generation === this._generation) {
        this._batchBaseline = undefined
        this._restoring = false
        this._suspendPersist = false
        // The grid now holds this workspace's editors, so persisted recency ids
        // can be resolved again — also on the failure path, where the grid was at
        // least left in a settled state.
        this._recentTargets.rebaseAfterRestore()
      }
    }
  }

  private _collectEditors(): EditorInput[] {
    return this._groups.groups.flatMap((group) => group.editors)
  }

  /** Anything present after a restore but not before it was materialized by it. */
  private _markRestoreProduced(before: ReadonlySet<EditorInput>): void {
    for (const editor of this._collectEditors()) {
      if (!before.has(editor)) this._restoreProduced.add(editor)
    }
  }

  private _instantiationAccessor(): ServicesAccessor {
    // IAuxiliaryEditorWindowService.restore only needs the accessor for editor
    // deserialization; hand it one backed by the same DI container. Each get()
    // opens its own invocation, so it stays valid across the restore's awaits.
    return {
      get: <T>(id: ServiceIdentifier<T>): T =>
        this._instantiation.invokeFunction((accessor) => accessor.get(id)),
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
      await recordPerfPhaseAsync('workspaceRestore.persist', async () => {
        const auxiliaryWindows = this._auxWindows.serialize()
        const state: PersistedWorkspaceState = {
          groups: (this._groups as EditorGroupsService).toJSON(),
          ...(auxiliaryWindows.windows.length > 0 ? { auxiliaryWindows } : {}),
        }
        await this._storage.set(WORKSPACE_STATE_STORAGE_KEY, state, StorageScope.WORKSPACE)
      })
      this._logger.debug(`persisted workspace state groups=${this._groups.groups.length}`)
    } catch (err) {
      this._logger.warn(
        'failed to persist workspace state',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    }
  }

  private async _flush(): Promise<void> {
    if (this._persistTimer !== null) {
      clearTimeout(this._persistTimer)
      this._persistTimer = null
    }
    await this._persist()
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
