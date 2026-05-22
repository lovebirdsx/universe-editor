/*---------------------------------------------------------------------------------------------
 *  Tests for ProgressService — verify 150ms delay, three-location routing, and
 *  cancellation plumbing through the CancellationToken.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observableValue, ProgressLocation, Severity } from '@universe-editor/platform'
import type {
  CancellationToken,
  INotification,
  INotificationHandle,
  INotificationProgress,
  INotificationProgressOptions,
  INotificationService,
  IObservable,
  IPromptChoice,
  IStatusBarEntry,
  IStatusBarEntryAccessor,
  IStatusBarService,
  IStoredStatusBarEntry,
} from '@universe-editor/platform'
import { ProgressService } from '../ProgressService.js'

class StubStatusBarService implements IStatusBarService {
  declare readonly _serviceBrand: undefined
  readonly entries: IObservable<readonly IStoredStatusBarEntry[]> = observableValue(
    'stub.entries',
    [],
  )
  readonly added: IStatusBarEntry[] = []
  readonly updates: IStatusBarEntry[] = []
  disposed = 0
  addEntry(entry: IStatusBarEntry): IStatusBarEntryAccessor {
    this.added.push(entry)
    return {
      update: (next) => {
        this.updates.push(next)
      },
      dispose: () => {
        this.disposed++
      },
    }
  }
}

interface RecordedNotification {
  message: string
  severity: Severity
  sticky?: boolean
  progress?: INotificationProgressOptions
}

class StubNotificationService implements INotificationService {
  declare readonly _serviceBrand: undefined
  readonly notifications: IObservable<readonly INotification[]> = observableValue('stub.notif', [])
  readonly unreadCount: IObservable<number> = observableValue('stub.unread', 0)
  readonly centerVisible: IObservable<boolean> = observableValue('stub.center', false)
  readonly captured: RecordedNotification[] = []
  readonly progressReports: Array<Parameters<INotificationProgress['report']>[0]> = []
  doneCount = 0
  disposedCount = 0
  dismissed: string[] = []
  private _lastOptions: INotificationProgressOptions | undefined
  notify(opts: {
    severity: Severity
    message: string
    actions?: IPromptChoice[]
    sticky?: boolean
    progress?: INotificationProgressOptions
  }): INotificationHandle {
    const captured: RecordedNotification = {
      message: opts.message,
      severity: opts.severity,
      ...(opts.sticky !== undefined ? { sticky: opts.sticky } : {}),
      ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
    }
    this.captured.push(captured)
    this._lastOptions = opts.progress
    const id = `n-${this.captured.length}`
    const progress: INotificationProgress = {
      report: (s) => this.progressReports.push(s),
      done: () => {
        this.doneCount++
      },
    }
    return {
      id,
      progress,
      updateMessage: () => {},
      updateSeverity: () => {},
      dispose: () => {
        this.disposedCount++
      },
    }
  }
  prompt(): Promise<void> {
    return Promise.resolve()
  }
  status(): INotificationHandle {
    return {
      id: 'noop',
      progress: { report: () => {}, done: () => {} },
      updateMessage: () => {},
      updateSeverity: () => {},
      dispose: () => {},
    }
  }
  dismiss(id: string): void {
    this.dismissed.push(id)
  }
  cancelProgress(id: string): void {
    // Mirror real service semantics: drop handler then invoke.
    const handler = this._lastOptions?.onCancel
    this._lastOptions = undefined
    if (handler) handler()
    void id
  }
  clearAll(): void {}
  toggleCenter(): void {}
  markAllAsRead(): void {}
}

describe('ProgressService', () => {
  let statusBar: StubStatusBarService
  let notification: StubNotificationService
  let svc: ProgressService

  beforeEach(() => {
    vi.useFakeTimers()
    statusBar = new StubStatusBarService()
    notification = new StubNotificationService()
    svc = new ProgressService(statusBar, notification)
  })

  afterEach(() => {
    svc.dispose()
    vi.useRealTimers()
  })

  it('does not mount UI when the task finishes before delay elapses', async () => {
    const p = svc.withProgress(
      { location: ProgressLocation.Notification, title: 'fast' },
      async () => 'ok',
    )
    // Don't advance timers — task resolves synchronously through microtasks.
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toBe('ok')
    expect(notification.captured).toHaveLength(0)
    expect(statusBar.added).toHaveLength(0)
  })

  it('mounts a notification after the 150ms delay and replays buffered steps', async () => {
    let release!: () => void
    const p = svc.withProgress(
      {
        location: ProgressLocation.Notification,
        title: 'load',
        cancellable: true,
      },
      (progress) =>
        new Promise<string>((resolve) => {
          // Report before the UI mounts — must be buffered.
          progress.report({ message: 'early', increment: 25 })
          release = () => resolve('done')
        }),
    )

    await vi.advanceTimersByTimeAsync(150)

    expect(notification.captured).toHaveLength(1)
    expect(notification.captured[0]?.severity).toBe(Severity.Info)
    expect(notification.captured[0]?.sticky).toBe(true)
    expect(notification.captured[0]?.progress?.cancellable).toBe(true)
    // Buffered report should have been replayed.
    expect(notification.progressReports).toHaveLength(1)
    expect(notification.progressReports[0]?.increment).toBeCloseTo(25)
    expect(notification.progressReports[0]?.message).toBe('early')

    release()
    expect(await p).toBe('done')
    expect(notification.doneCount).toBe(1)
    expect(notification.dismissed).toContain('n-1')
  })

  it('routes Window location to the StatusBar with a spinner', async () => {
    let release!: () => void
    const p = svc.withProgress(
      { location: ProgressLocation.Window, title: 'sync' },
      (progress) =>
        new Promise<void>((resolve) => {
          release = () => {
            progress.report({ message: 'phase-2' })
            resolve()
          }
        }),
    )
    await vi.advanceTimersByTimeAsync(150)
    expect(statusBar.added).toHaveLength(1)
    expect(statusBar.added[0]?.text).toBe('sync')
    expect(statusBar.added[0]?.showProgress).toBe('spinning')

    release()
    await p
    expect(statusBar.disposed).toBe(1)
    expect(statusBar.updates.at(-1)?.text).toContain('phase-2')
  })

  it('routes Dialog location through the dialogState observable', async () => {
    let release!: () => void
    const p = svc.withProgress(
      {
        location: ProgressLocation.Dialog,
        title: 'save',
        cancellable: true,
      },
      (progress) =>
        new Promise<void>((resolve) => {
          progress.report({ message: 'writing', increment: 50, total: 100 })
          release = () => resolve()
        }),
    )
    await vi.advanceTimersByTimeAsync(150)
    const state = svc.dialogState.get()
    expect(state?.title).toBe('save')
    expect(state?.message).toBe('writing')
    expect(state?.cancellable).toBe(true)
    expect(state?.percent).toBeCloseTo(50)
    release()
    await p
    expect(svc.dialogState.get()).toBeNull()
  })

  it('cancellable notification triggers the CancellationToken when the UI cancels', async () => {
    let observed: CancellationToken | undefined
    const p = svc.withProgress(
      {
        location: ProgressLocation.Notification,
        title: 'long',
        cancellable: true,
      },
      (_progress, token) =>
        new Promise<string>((resolve) => {
          observed = token
          token.onCancellationRequested(() => resolve('cancelled'))
        }),
    )
    await vi.advanceTimersByTimeAsync(150)

    // Simulate user pressing Cancel on the toast.
    notification.cancelProgress('n-1')

    expect(observed?.isCancellationRequested).toBe(true)
    expect(await p).toBe('cancelled')
  })
})
