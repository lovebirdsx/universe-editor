/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-process implementation of INotificationService.
 *  Renderer-only; no IPC — the main process has no direct notification UI.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  Severity,
  StorageScope,
  derived,
  localize,
  observableValue,
} from '@universe-editor/platform'
import type {
  INotification,
  INotificationHandle,
  INotificationProgress,
  INotificationPromptOptions,
  IObservable,
  IPromptChoice,
} from '@universe-editor/platform'
import type {
  IDocumentAwareNotificationService,
  NotificationOptions,
} from './notificationDocumentRouting.js'
import {
  currentWorkbenchDocumentOrUndefined,
  onDidRemoveWorkbenchDocument,
} from '../windows/workbenchDocuments.js'

const STORAGE_KEY = 'workbench.notifications.list'
const MAX_STORED = 50
const AUTO_READ_MS = 3000
const PERSIST_DEBOUNCE_MS = 500

export class NotificationService extends Disposable implements IDocumentAwareNotificationService {
  declare readonly _serviceBrand: undefined

  private _nextId = 0
  private _items: INotification[] = []

  /** Origin document per notification; renderer-only and never persisted. */
  private readonly _origins = new Map<string, Document>()
  private readonly _originsValue = observableValue<ReadonlyMap<string, Document>>(
    'NotificationService.notificationOrigins',
    new Map(),
  )
  private readonly _centerDocument = observableValue<Document | undefined>(
    'NotificationService.centerDocument',
    undefined,
  )

  readonly notificationOrigins: IObservable<ReadonlyMap<string, Document>> = this._originsValue
  readonly centerDocument: IObservable<Document | undefined> = this._centerDocument

  /** Timers that mark non-sticky notifications as read after AUTO_READ_MS. */
  private readonly _readTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Settle functions for pending prompt() calls, keyed by notification id. */
  private readonly _promptSettlers = new Map<string, () => void>()
  /** Cancel callbacks for cancellable progress notifications. */
  private readonly _cancelHandlers = new Map<string, () => void>()
  private _persistTimer: ReturnType<typeof setTimeout> | undefined

  readonly notifications = observableValue<readonly INotification[]>(
    'NotificationService.notifications',
    [],
  )

  readonly unreadCount = derived(
    this,
    (reader) => this.notifications.read(reader).filter((n) => !n.read).length,
  )

  readonly centerVisible = observableValue<boolean>('NotificationService.centerVisible', false)

  constructor(@IStorageService private readonly _storage: IStorageService) {
    super()
    // An item pinned to a closed auxiliary window must fall back to the main
    // window instead of holding a dead document (and its DOM) alive.
    this._register(onDidRemoveWorkbenchDocument((doc) => this._forgetDocument(doc)))
    void this._load()
  }

  private async _load(): Promise<void> {
    const raw = await this._storage.get<unknown[]>(STORAGE_KEY)
    // Notifications created while the storage read was in flight are live; a
    // restored entry with the same id is the stale copy. Keep the live one so
    // its origin/handle stays paired with an existing item.
    const live = this._items
    const liveIds = new Set(live.map((n) => n.id))
    const restored = Array.isArray(raw)
      ? (raw as INotification[]).filter((entry) => !liveIds.has(entry.id))
      : []
    this._items = [
      ...restored.map((entry) => ({
        id: entry.id,
        severity: entry.severity,
        message: entry.message,
        sticky: entry.sticky,
        timestamp: entry.timestamp,
        ...(entry.progress === undefined ? {} : { progress: entry.progress }),
        ...(entry.cancellable === undefined ? {} : { cancellable: entry.cancellable }),
        read: true,
        dismissed: false,
      })),
      ...live,
    ]
    // Advance _nextId past any restored ids, otherwise new notifications would
    // reuse ids and _findItem would resolve to the stale restored entry.
    let maxId = -1
    for (const item of this._items) {
      const match = /^notification-(\d+)$/.exec(item.id)
      if (match !== null) {
        const n = Number(match[1])
        if (Number.isFinite(n) && n > maxId) maxId = n
      }
    }
    if (maxId >= this._nextId) this._nextId = maxId + 1
    this.notifications.set([...this._items], undefined)
  }

  notify(opts: NotificationOptions): INotificationHandle {
    return this.notifyWithOrigin(currentWorkbenchDocumentOrUndefined(), opts)
  }

  notifyWithOrigin(origin: Document | undefined, opts: NotificationOptions): INotificationHandle {
    const id = `notification-${this._nextId++}`
    if (origin !== undefined) {
      this._origins.set(id, origin)
      this._publishOrigins()
    }
    const cancellable = opts.progress?.cancellable === true
    const notification: INotification = {
      id,
      severity: opts.severity,
      message: opts.message,
      sticky: opts.sticky ?? false,
      timestamp: Date.now(),
      read: false,
      dismissed: false,
      ...(opts.actions !== undefined ? { actions: opts.actions } : {}),
      ...(cancellable ? { cancellable: true } : {}),
    }
    if (cancellable && opts.progress?.onCancel) {
      this._cancelHandlers.set(id, opts.progress.onCancel)
    }

    this._items = [...this._items, notification]
    this._syncObservable()
    this._schedulePersist()

    // Non-sticky: mark as read (remove from toast) after AUTO_READ_MS.
    if (!notification.sticky) {
      const timer = setTimeout(() => {
        this._markAsRead(id)
      }, AUTO_READ_MS)
      this._readTimers.set(id, timer)
    }

    const progress: INotificationProgress = {
      report: (state) => {
        const item = this._findItem(id)
        if (!item) return
        const prev = item.progress
        item.progress = {
          done: false,
          ...(prev?.message !== undefined ? { message: prev.message } : {}),
          ...(prev?.increment !== undefined ? { increment: prev.increment } : {}),
          ...(prev?.total !== undefined ? { total: prev.total } : {}),
          ...(state.message !== undefined ? { message: state.message } : {}),
          ...(state.increment !== undefined ? { increment: state.increment } : {}),
          ...(state.total !== undefined ? { total: state.total } : {}),
        }
        this._syncObservable()
      },
      done: () => {
        const item = this._findItem(id)
        if (!item) return
        const prev = item.progress
        item.progress = {
          done: true,
          ...(prev?.message !== undefined ? { message: prev.message } : {}),
          ...(prev?.increment !== undefined ? { increment: prev.increment } : {}),
          ...(prev?.total !== undefined ? { total: prev.total } : {}),
        }
        this._syncObservable()
      },
    }

    return {
      id,
      progress,
      updateMessage: (message: string) => {
        const item = this._findItem(id)
        if (!item) return
        item.message = message
        this._syncObservable()
      },
      updateSeverity: (severity: Severity) => {
        const item = this._findItem(id)
        if (!item) return
        item.severity = severity
        this._syncObservable()
      },
      dispose: () => {
        this._clearReadTimer(id)
        this._cancelHandlers.delete(id)
      },
    }
  }

  async prompt(
    severity: Severity,
    message: string,
    choices: IPromptChoice[],
    options?: INotificationPromptOptions,
  ): Promise<void> {
    const neverShowAgain = options?.neverShowAgain
    if (neverShowAgain !== undefined) {
      // The user previously opted out of this prompt — stay silent.
      const suppressed = await this._storage.get<boolean>(neverShowAgain.id, StorageScope.GLOBAL)
      if (suppressed === true) return

      const action: IPromptChoice = {
        label: localize('notification.neverShowAgain', "Don't Show Again"),
        run: () => {
          void this._storage.set(neverShowAgain.id, true, StorageScope.GLOBAL)
        },
        ...(neverShowAgain.isSecondary !== undefined
          ? { isSecondary: neverShowAgain.isSecondary }
          : {}),
      }
      // VSCode parity: default placement is first, secondary goes last.
      choices = neverShowAgain.isSecondary === true ? [...choices, action] : [action, ...choices]
    }

    return new Promise<void>((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }

      const wrappedChoices: IPromptChoice[] = choices.map((c) => ({
        label: c.label,
        run: () => {
          settle()
          c.run()
        },
        ...(c.isSecondary !== undefined ? { isSecondary: c.isSecondary } : {}),
      }))

      const handle = this.notify({ severity, message, actions: wrappedChoices, sticky: true })
      this._promptSettlers.set(handle.id, settle)
    })
  }

  status(message: string, opts?: { sticky?: boolean }): INotificationHandle {
    return this.notify({
      severity: Severity.Info,
      message,
      ...(opts?.sticky !== undefined ? { sticky: opts.sticky } : {}),
    })
  }

  dismiss(id: string): void {
    this._clearReadTimer(id)
    this._cancelHandlers.delete(id)
    this._forgetOrigin(id)

    const settler = this._promptSettlers.get(id)
    if (settler !== undefined) {
      this._promptSettlers.delete(id)
      settler()
    }

    const item = this._findItem(id)
    if (!item) return
    item.dismissed = true
    this._syncObservable()
    this._schedulePersist()
  }

  cancelProgress(id: string): void {
    const handler = this._cancelHandlers.get(id)
    if (handler === undefined) return
    // Drop the handler before invoking — owners typically dismiss the
    // notification from inside the callback, and we don't want re-entry.
    this._cancelHandlers.delete(id)
    handler()
    // Re-arm while the notification is still up. A progress token is one-way,
    // but the owner may DECLINE the cancellation (the p4 extension asks before
    // killing the child), and a visible Cancel button that silently does
    // nothing is worse than no button at all. Owners that do finish on cancel
    // dismiss the notification, which marks the item and drops the handler.
    const item = this._findItem(id)
    if (item !== undefined && !item.dismissed) this._cancelHandlers.set(id, handler)
  }

  clearAll(): void {
    this._readTimers.forEach((t) => clearTimeout(t))
    this._readTimers.clear()

    this._promptSettlers.forEach((s) => s())
    this._promptSettlers.clear()

    this._cancelHandlers.clear()
    this._origins.clear()
    this._publishOrigins()

    for (const item of this._items) {
      item.dismissed = true
    }
    this.notifications.set([], undefined)

    if (this._persistTimer !== undefined) {
      clearTimeout(this._persistTimer)
      this._persistTimer = undefined
    }
    void this._storage.set(STORAGE_KEY, [])
  }

  toggleCenter(): void {
    const next = !this.centerVisible.get()
    this.centerVisible.set(next, undefined)
    if (next) {
      // The center belongs to the window it was opened in; opening it in an
      // auxiliary window must not paint the panel into the main one.
      this._centerDocument.set(currentWorkbenchDocumentOrUndefined(), undefined)
      for (const item of this._items) {
        if (!item.dismissed) item.read = true
      }
      this._syncObservable()
    } else {
      this._centerDocument.set(undefined, undefined)
    }
  }

  markAllAsRead(): void {
    let changed = false
    for (const item of this._items) {
      if (!item.dismissed && !item.read) {
        item.read = true
        changed = true
      }
    }
    // Cancel pending auto-read timers — they would no-op now anyway.
    this._readTimers.forEach((t) => clearTimeout(t))
    this._readTimers.clear()
    if (changed) this._syncObservable()
  }

  private _markAsRead(id: string): void {
    this._readTimers.delete(id)
    const item = this._findItem(id)
    if (!item) return
    item.read = true
    this._syncObservable()
  }

  private _findItem(id: string): INotification | undefined {
    return this._items.find((n) => n.id === id)
  }

  private _syncObservable(): void {
    this.notifications.set(
      this._items.filter((n) => !n.dismissed),
      undefined,
    )
  }

  private _publishOrigins(): void {
    this._originsValue.set(new Map(this._origins), undefined)
  }

  private _forgetOrigin(id: string): void {
    if (!this._origins.delete(id)) return
    this._publishOrigins()
  }

  private _forgetDocument(doc: Document): void {
    let changed = false
    for (const [id, origin] of this._origins) {
      if (origin !== doc) continue
      this._origins.delete(id)
      changed = true
    }
    if (changed) this._publishOrigins()
    if (this._centerDocument.get() === doc) this._centerDocument.set(undefined, undefined)
  }

  private _clearReadTimer(id: string): void {
    const timer = this._readTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this._readTimers.delete(id)
    }
  }

  private _schedulePersist(): void {
    if (this._persistTimer !== undefined) clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => {
      this._persistTimer = undefined
      void this._persist()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async _persist(): Promise<void> {
    const toStore = this._items.filter((n) => !n.dismissed).slice(-MAX_STORED)
    await this._storage.set(STORAGE_KEY, toStore)
  }

  override dispose(): void {
    this._readTimers.forEach((t) => clearTimeout(t))
    this._readTimers.clear()
    this._origins.clear()
    if (this._persistTimer !== undefined) {
      clearTimeout(this._persistTimer)
      this._persistTimer = undefined
    }
    super.dispose()
  }
}
