/*---------------------------------------------------------------------------------------------
 *  Unit tests for NotificationService and NotificationStatusContribution.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INotificationService,
  IStatusBarService,
  IStorageService,
  InstantiationService,
  Severity,
  ServiceCollection,
  StatusBarAlignment,
  autorun,
  type IStorageService as IStorageServiceType,
  type IStatusBarService as IStatusBarServiceType,
} from '@universe-editor/platform'
import { NotificationService } from '../NotificationService.js'
import { NotificationStatusContribution } from '../NotificationStatusContribution.js'
import { StatusBarService } from '../../statusbar/StatusBarService.js'

// ---------------------------------------------------------------------------
// FakeStorage
// ---------------------------------------------------------------------------

class FakeStorage implements IStorageServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _data = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this._data.get(key) as T | undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    this._data.set(key, value)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildService(storage?: FakeStorage): NotificationService {
  const services = new ServiceCollection()
  services.set(IStorageService, storage ?? new FakeStorage())
  const inst = new InstantiationService(services)
  return inst.createInstance(NotificationService)
}

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

describe('NotificationService', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('notify() appends to notifications observable', () => {
    const svc = buildService()
    svc.notify({ severity: Severity.Info, message: 'hello' })
    const items = svc.notifications.get()
    expect(items).toHaveLength(1)
    expect(items[0]?.message).toBe('hello')
    expect(items[0]?.read).toBe(false)
    svc.dispose()
  })

  it('non-sticky notification is marked as read after 3 s (fake timers)', () => {
    vi.useFakeTimers()
    const svc = buildService()
    svc.notify({ severity: Severity.Info, message: 'auto' })
    expect(svc.notifications.get()[0]?.read).toBe(false)

    vi.advanceTimersByTime(3000)
    expect(svc.notifications.get()[0]?.read).toBe(true)
    expect(svc.unreadCount.get()).toBe(0)
    svc.dispose()
  })

  it('sticky notification is never auto-marked as read', () => {
    vi.useFakeTimers()
    const svc = buildService()
    svc.notify({ severity: Severity.Error, message: 'sticky', sticky: true })
    vi.advanceTimersByTime(10_000)
    expect(svc.notifications.get()[0]?.read).toBe(false)
    expect(svc.unreadCount.get()).toBe(1)
    svc.dispose()
  })

  it('prompt() resolves when a choice is picked', async () => {
    const svc = buildService()
    let called = false
    const p = svc.prompt(Severity.Warning, 'Pick one?', [
      {
        label: 'Yes',
        run: () => {
          called = true
        },
      },
    ])

    // Trigger the choice via the notification's action.
    const notification = svc.notifications.get()[0]
    notification?.actions?.[0]?.run()

    await p
    expect(called).toBe(true)
    svc.dispose()
  })

  it('prompt() resolves when the notification is dismissed (cancel)', async () => {
    const svc = buildService()
    let resolved = false
    const p = svc.prompt(Severity.Warning, 'Pick one?', [{ label: 'Yes', run: () => {} }])
    p.then(() => {
      resolved = true
    })

    const id = svc.notifications.get()[0]?.id
    if (id !== undefined) svc.dismiss(id)

    await p
    expect(resolved).toBe(true)
    svc.dispose()
  })

  it('progress lifecycle: report → done', () => {
    const svc = buildService()
    const handle = svc.notify({ severity: Severity.Info, message: 'working…' })
    handle.progress.report({ message: 'step 1', increment: 30 })

    let n = svc.notifications.get()[0]
    expect(n?.progress?.done).toBe(false)
    expect(n?.progress?.message).toBe('step 1')

    handle.progress.done()
    n = svc.notifications.get()[0]
    expect(n?.progress?.done).toBe(true)
    svc.dispose()
  })

  it('clearAll() empties the list and persists immediately', async () => {
    const storage = new FakeStorage()
    const spy = vi.spyOn(storage, 'set')
    const svc = buildService(storage)
    svc.notify({ severity: Severity.Info, message: 'a' })
    svc.notify({ severity: Severity.Info, message: 'b' })
    expect(svc.notifications.get()).toHaveLength(2)

    svc.clearAll()
    expect(svc.notifications.get()).toHaveLength(0)
    // clearAll calls storage.set directly (not debounced)
    expect(spy).toHaveBeenCalledWith('workbench.notifications.list', [])
    svc.dispose()
  })

  it('notify() schedules debounced persist to storage', async () => {
    vi.useFakeTimers()
    const storage = new FakeStorage()
    const spy = vi.spyOn(storage, 'set')
    const svc = buildService(storage)
    svc.notify({ severity: Severity.Info, message: 'x' })
    // Before debounce fires: no persist call yet
    expect(spy).not.toHaveBeenCalled()
    // After debounce (500 ms)
    vi.advanceTimersByTime(500)
    // Flush the resolved promise
    await Promise.resolve()
    expect(spy).toHaveBeenCalledWith('workbench.notifications.list', expect.any(Array))
    svc.dispose()
  })

  it('toggleCenter() marks all as read when opening', () => {
    const svc = buildService()
    svc.notify({ severity: Severity.Info, message: '1' })
    svc.notify({ severity: Severity.Warning, message: '2' })
    expect(svc.unreadCount.get()).toBe(2)

    svc.toggleCenter()
    expect(svc.centerVisible.get()).toBe(true)
    expect(svc.unreadCount.get()).toBe(0)
    svc.dispose()
  })

  it('markAllAsRead() clears unread count without opening the center', () => {
    const svc = buildService()
    svc.notify({ severity: Severity.Info, message: '1' })
    svc.notify({ severity: Severity.Warning, message: '2' })
    expect(svc.unreadCount.get()).toBe(2)

    svc.markAllAsRead()
    expect(svc.centerVisible.get()).toBe(false)
    expect(svc.unreadCount.get()).toBe(0)
    // Items remain in the list (center still shows them); they're just read.
    expect(svc.notifications.get()).toHaveLength(2)
    svc.dispose()
  })

  it('dismiss() targets the right item after restore (no id collision)', async () => {
    // Seed storage with one item using id "notification-0" — the same id the
    // counter would mint for a fresh notification if not advanced.
    const storage = new FakeStorage()
    await storage.set('workbench.notifications.list', [
      {
        id: 'notification-0',
        severity: Severity.Info,
        message: 'restored',
        sticky: false,
        timestamp: 1,
        read: true,
        dismissed: false,
      },
    ])
    const svc = buildService(storage)
    // Wait a microtask for _load() to flush.
    await Promise.resolve()
    await Promise.resolve()

    const handle = svc.notify({ severity: Severity.Info, message: 'fresh' })
    expect(handle.id).not.toBe('notification-0')

    // Dismiss the fresh one — restored item must remain visible.
    svc.dismiss(handle.id)
    const remaining = svc.notifications.get()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.message).toBe('restored')
    svc.dispose()
  })
})

// ---------------------------------------------------------------------------
// NotificationStatusContribution
// ---------------------------------------------------------------------------

describe('NotificationStatusContribution', () => {
  let notificationSvc: NotificationService
  let statusBarSvc: IStatusBarServiceType
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    notificationSvc = buildService()
    statusBarSvc = new StatusBarService()
  })

  afterEach(() => {
    while (disposables.length) disposables.pop()!.dispose()
    notificationSvc.dispose()
  })

  function buildContribution(): NotificationStatusContribution {
    const services = new ServiceCollection()
    services.set(INotificationService, notificationSvc)
    services.set(IStatusBarService, statusBarSvc)
    const inst = new InstantiationService(services)
    const contrib = inst.createInstance(NotificationStatusContribution)
    disposables.push(contrib)
    return contrib
  }

  it('shows bell without count when there are no unread notifications', () => {
    buildContribution()
    const entries = statusBarSvc.entries.get()
    const bellEntry = entries.find((e) => e.entry.alignment === StatusBarAlignment.Right)
    // No unread → text should not contain a number
    expect(bellEntry?.entry.text).not.toMatch(/\d/)
  })

  it('shows bell with count when unread notifications exist', () => {
    buildContribution()
    notificationSvc.notify({ severity: Severity.Warning, message: 'warn' })
    notificationSvc.notify({ severity: Severity.Info, message: 'info' })

    const entries = statusBarSvc.entries.get()
    const bellEntry = entries.find((e) => e.entry.alignment === StatusBarAlignment.Right)
    expect(bellEntry?.entry.text).toContain('2')
  })

  it('updates badge reactively when notifications change', () => {
    buildContribution()
    const spy = vi.fn()
    const d = autorun((r) => {
      statusBarSvc.entries.read(r)
      spy()
    })
    disposables.push(d)
    spy.mockClear()

    notificationSvc.notify({ severity: Severity.Info, message: 'x' })
    // Badge should have updated (statusBar entries observable changed)
    expect(spy).toHaveBeenCalled()
  })
})
