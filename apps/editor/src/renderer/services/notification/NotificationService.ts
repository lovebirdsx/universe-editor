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
  INotificationProgressOptions,
  INotificationPromptOptions,
  INotificationService,
  IPromptChoice,
} from '@universe-editor/platform'

const STORAGE_KEY = 'workbench.notifications.list'
const MAX_STORED = 50
const AUTO_READ_MS = 3000
const PERSIST_DEBOUNCE_MS = 500

export class NotificationService extends Disposable implements INotificationService {
  declare readonly _serviceBrand: undefined

  private _nextId = 0
  private _items: INotification[] = []

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
    void this._load()
  }

  private async _load(): Promise<void> {
    const raw = await this._storage.get<unknown[]>(STORAGE_KEY)
    if (!Array.isArray(raw) || raw.length === 0) return
    // Restore as read — they appear in center but not as fresh toasts.
    this._items = (raw as INotification[]).map((n) => ({ ...n, read: true, dismissed: false }))
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

  notify(opts: {
    severity: Severity
    message: string
    actions?: IPromptChoice[]
    sticky?: boolean
    progress?: INotificationProgressOptions
  }): INotificationHandle {
    const id = `notification-${this._nextId++}`
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
  }

  clearAll(): void {
    this._readTimers.forEach((t) => clearTimeout(t))
    this._readTimers.clear()

    this._promptSettlers.forEach((s) => s())
    this._promptSettlers.clear()

    this._cancelHandlers.clear()

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
      for (const item of this._items) {
        if (!item.dismissed) item.read = true
      }
      this._syncObservable()
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
    if (this._persistTimer !== undefined) {
      clearTimeout(this._persistTimer)
      this._persistTimer = undefined
    }
    super.dispose()
  }
}
