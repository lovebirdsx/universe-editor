/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IProgressService implementation — routes withProgress() to StatusBar /
 *  NotificationService / a self-managed Dialog overlay.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  Disposable,
  IStatusBarService,
  INotificationService,
  ProgressLocation,
  Severity,
  StatusBarAlignment,
  observableValue,
} from '@universe-editor/platform'
import type {
  CancellationToken,
  IObservable,
  IProgress,
  IProgressOptions,
  IProgressService,
  IProgressStep,
  IStatusBarEntryAccessor,
} from '@universe-editor/platform'

const DEFAULT_DELAY_MS = 150
const WINDOW_STATUS_PRIORITY = 50

/** Public state observed by ProgressDialogHost — null when no dialog progress active. */
export interface DialogProgressState {
  readonly title: string
  readonly message: string | undefined
  /** 0-100, or undefined for indeterminate. */
  readonly percent: number | undefined
  readonly cancellable: boolean
  readonly cancel: () => void
}

export class ProgressService extends Disposable implements IProgressService {
  declare readonly _serviceBrand: undefined

  private readonly _dialogState = observableValue<DialogProgressState | null>(
    'ProgressService.dialogState',
    null,
  )

  readonly dialogState: IObservable<DialogProgressState | null> = this._dialogState

  constructor(
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @INotificationService private readonly _notification: INotificationService,
  ) {
    super()
  }

  async withProgress<R>(
    options: IProgressOptions,
    task: (progress: IProgress<IProgressStep>, token: CancellationToken) => Promise<R>,
  ): Promise<R> {
    const cts = new CancellationTokenSource()
    const delay = options.delay ?? DEFAULT_DELAY_MS

    // Steps reported before the UI mounts are buffered into `pending` and
    // replayed once the UI handle attaches.
    let pending: IProgressStep[] = []
    let liveProgress: IProgress<IProgressStep> | undefined
    const proxy: IProgress<IProgressStep> = {
      report: (step) => {
        if (liveProgress !== undefined) liveProgress.report(step)
        else pending.push(step)
      },
    }

    let uiDispose: (() => void) | undefined

    const mount = (): void => {
      switch (options.location) {
        case ProgressLocation.Window: {
          const [progress, dispose] = this._mountWindow(options, cts)
          liveProgress = progress
          uiDispose = dispose
          break
        }
        case ProgressLocation.Notification: {
          const [progress, dispose] = this._mountNotification(options, cts)
          liveProgress = progress
          uiDispose = dispose
          break
        }
        case ProgressLocation.Dialog: {
          const [progress, dispose] = this._mountDialog(options, cts)
          liveProgress = progress
          uiDispose = dispose
          break
        }
      }
      // Replay any steps that arrived before the UI mounted.
      if (pending.length > 0 && liveProgress !== undefined) {
        for (const step of pending) liveProgress.report(step)
        pending = []
      }
    }

    const showTimer = setTimeout(mount, delay)

    try {
      return await task(proxy, cts.token)
    } finally {
      clearTimeout(showTimer)
      uiDispose?.()
      cts.dispose()
    }
  }

  // ─── Window (status bar) ────────────────────────────────────────────────

  private _mountWindow(
    options: IProgressOptions,
    cts: CancellationTokenSource,
  ): [IProgress<IProgressStep>, () => void] {
    let accessor: IStatusBarEntryAccessor | undefined = this._statusBar.addEntry({
      text: options.title,
      alignment: StatusBarAlignment.Left,
      priority: WINDOW_STATUS_PRIORITY,
      showProgress: 'spinning',
      ...(options.source !== undefined ? { tooltip: options.source } : {}),
    })

    const progress: IProgress<IProgressStep> = {
      report: (step) => {
        if (accessor === undefined) return
        const text = step.message ? `${options.title}: ${step.message}` : options.title
        accessor.update({
          text,
          alignment: StatusBarAlignment.Left,
          priority: WINDOW_STATUS_PRIORITY,
          showProgress: 'spinning',
          ...(options.source !== undefined ? { tooltip: options.source } : {}),
        })
      },
    }

    void cts // Window location ignores cancellation visually (silent); the token still works for owners.

    return [
      progress,
      () => {
        accessor?.dispose()
        accessor = undefined
      },
    ]
  }

  // ─── Notification (toast + center) ──────────────────────────────────────

  private _mountNotification(
    options: IProgressOptions,
    cts: CancellationTokenSource,
  ): [IProgress<IProgressStep>, () => void] {
    const handle = this._notification.notify({
      severity: Severity.Info,
      message: options.title,
      sticky: true,
      ...(options.cancellable === true
        ? {
            progress: {
              cancellable: true,
              onCancel: () => {
                cts.cancel()
              },
            },
          }
        : {}),
    })

    // Accumulate increments (VSCode semantics): each report adds to the bar.
    let cumulative = 0
    let total: number | undefined
    const progress: IProgress<IProgressStep> = {
      report: (step) => {
        if (step.total !== undefined) total = step.total
        let percent: number | undefined
        if (step.increment !== undefined) {
          if (total !== undefined && total > 0) {
            cumulative += (step.increment / total) * 100
          } else {
            cumulative += step.increment
          }
          percent = Math.min(100, Math.max(0, cumulative))
        }
        handle.progress.report({
          ...(step.message !== undefined ? { message: step.message } : {}),
          ...(percent !== undefined ? { increment: percent } : {}),
        })
        if (step.message !== undefined) handle.updateMessage(`${options.title} — ${step.message}`)
      },
    }

    return [
      progress,
      () => {
        handle.progress.done()
        this._notification.dismiss(handle.id)
        handle.dispose()
      },
    ]
  }

  // ─── Dialog (modal overlay) ─────────────────────────────────────────────

  private _mountDialog(
    options: IProgressOptions,
    cts: CancellationTokenSource,
  ): [IProgress<IProgressStep>, () => void] {
    const cancel = (): void => {
      cts.cancel()
    }
    const baseState: DialogProgressState = {
      title: options.title,
      message: undefined,
      percent: undefined,
      cancellable: options.cancellable === true,
      cancel,
    }
    this._dialogState.set(baseState, undefined)

    let cumulative = 0
    let total: number | undefined

    const progress: IProgress<IProgressStep> = {
      report: (step) => {
        if (step.total !== undefined) total = step.total
        let percent = this._dialogState.get()?.percent
        if (step.increment !== undefined) {
          if (total !== undefined && total > 0) {
            cumulative += (step.increment / total) * 100
          } else {
            cumulative += step.increment
          }
          percent = Math.min(100, Math.max(0, cumulative))
        }
        const prev = this._dialogState.get()
        if (prev === null) return
        this._dialogState.set(
          {
            title: prev.title,
            message: step.message ?? prev.message,
            percent,
            cancellable: prev.cancellable,
            cancel: prev.cancel,
          },
          undefined,
        )
      },
    }

    return [
      progress,
      () => {
        this._dialogState.set(null, undefined)
      },
    ]
  }
}
