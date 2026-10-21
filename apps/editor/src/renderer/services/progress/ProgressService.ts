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
  IProgressService,
  InstantiationType,
  registerSingleton,
} from '@universe-editor/platform'
import type {
  CancellationToken,
  IObservable,
  IProgress,
  IProgressOptions,
  IProgressStep,
  IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import type { DialogProgressState } from '@universe-editor/workbench-ui'
import type {
  IDocumentAwareNotificationService,
  NotificationOptions,
} from '../notification/notificationDocumentRouting.js'
import {
  currentWorkbenchDocumentOrUndefined,
  onDidRemoveWorkbenchDocument,
} from '../windows/workbenchDocuments.js'

export type { DialogProgressState }

const DEFAULT_DELAY_MS = 150
const WINDOW_STATUS_PRIORITY = 50

export class ProgressService extends Disposable implements IProgressService {
  declare readonly _serviceBrand: undefined

  private readonly _dialogState = observableValue<DialogProgressState | null>(
    'ProgressService.dialogState',
    null,
  )

  readonly dialogState: IObservable<DialogProgressState | null> = this._dialogState

  /** Window the dialog progress was started in (auxiliary-window aware). */
  private readonly _dialogDocument = observableValue<Document | undefined>(
    'ProgressService.dialogDocument',
    undefined,
  )
  readonly dialogDocument: IObservable<Document | undefined> = this._dialogDocument

  constructor(
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @INotificationService private readonly _notification: INotificationService,
  ) {
    super()
    // Drop the pin when the origin window closes: the host would fall back to
    // the main window anyway, and keeping the dead document here retains its DOM.
    this._register(
      onDidRemoveWorkbenchDocument((doc) => {
        if (this._dialogDocument.get() === doc) this._dialogDocument.set(undefined, undefined)
      }),
    )
  }

  async withProgress<R>(
    options: IProgressOptions,
    task: (progress: IProgress<IProgressStep>, token: CancellationToken) => Promise<R>,
  ): Promise<R> {
    const cts = new CancellationTokenSource()
    const delay = options.delay ?? DEFAULT_DELAY_MS
    // Capture at entry, not at mount: the UI appears after `delay`, by which
    // time the user may already have switched to another window.
    const origin = currentWorkbenchDocumentOrUndefined()

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
          const [progress, dispose] = this._mountNotification(options, cts, origin)
          liveProgress = progress
          uiDispose = dispose
          break
        }
        case ProgressLocation.Dialog: {
          const [progress, dispose] = this._mountDialog(options, cts, origin)
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
    origin: Document | undefined,
  ): [IProgress<IProgressStep>, () => void] {
    const notifyOptions: NotificationOptions = {
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
    }
    const documentAware = this._notification as Partial<IDocumentAwareNotificationService>
    const handle =
      typeof documentAware.notifyWithOrigin === 'function'
        ? documentAware.notifyWithOrigin(origin, notifyOptions)
        : this._notification.notify(notifyOptions)

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
    origin: Document | undefined,
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
    this._dialogDocument.set(origin, undefined)
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
        this._dialogDocument.set(undefined, undefined)
      },
    ]
  }
}

registerSingleton(IProgressService, ProgressService, InstantiationType.Delayed)
