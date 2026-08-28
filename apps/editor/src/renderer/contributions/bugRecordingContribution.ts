/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Hosts every renderer-side bug recording hook plus the status-bar indicator.
 *  Command execution, editor opens and ACP lifecycle already flow through
 *  ITelemetryService (bridged in main.tsx), so what is left here is what telemetry
 *  does not see: text edits (aggregated), editor switches, warning/error
 *  notifications, and ACP conversation content.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  DisposableMap,
  DisposableStore,
  EditorInput,
  IEditorService,
  INotificationService,
  IStatusBarService,
  localize,
  Severity,
  StatusBarAlignment,
  type IObservable,
  type IStatusBarEntryAccessor,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import type { IAcpSession, TimelineItem } from '../services/acp/session/acpSessionModel.js'
import {
  IBugRecorderClient,
  type BugRecorderClient,
} from '../services/bugRecording/bugRecorderClient.js'
import { EditAggregator } from '../services/bugRecording/editAggregator.js'
import { StopBugRecordingAction } from '../actions/bugRecordingActions.js'

type MonacoTextModel = ReturnType<typeof MonacoModelRegistry.models>[number]

const ACP_MESSAGE_MAX_LENGTH = 2000
const ACP_TOOL_INPUT_MAX_LENGTH = 1000
const NOTIFICATION_MAX_LENGTH = 500

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function formatElapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export class BugRecordingContribution extends Disposable implements IWorkbenchContribution {
  private _entry: IStatusBarEntryAccessor | undefined
  private _ticker: ReturnType<typeof setInterval> | undefined
  private readonly _acpStore = this._register(new DisposableStore())
  /** Timeline length at subscribe time, so a recording captures only new turns. */
  private readonly _acpBaselines = new Map<string, number>()
  private readonly _seenNotifications = new Set<string>()
  private readonly _edits: EditAggregator

  constructor(
    @IBugRecorderClient private readonly _recorder: BugRecorderClient,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
    @IEditorService editorService: IEditorService,
    @INotificationService notificationService: INotificationService,
    @IAcpSessionService acpSessionService: IAcpSessionService,
  ) {
    super()

    this._edits = new EditAggregator((edits) => {
      for (const edit of edits) {
        this._recorder.recordEvent({ kind: 'edit', count: edit.count, resource: edit.resource })
      }
    })
    this._register({ dispose: () => this._edits.dispose() })
    // Drains the debounce window into the bundle that is about to be packed;
    // must happen before the status flips to idle, hence via the client rather
    // than from _hide().
    this._register(this._recorder.registerFlushParticipant(() => this._edits.flush()))

    this._registerModelHooks()

    this._register(
      autorun((r) => {
        const active = editorService.activeEditor.read(r)
        // Non-file inputs (session/settings/webview editors) have no resource;
        // their id still identifies them well enough for the timeline.
        const resource = active instanceof EditorInput ? active.resource?.toString() : active?.id
        this._recorder.recordEvent({
          kind: 'editorSwitch',
          ...(resource !== undefined ? { resource } : {}),
        })
      }),
    )

    this._register(
      autorun((r) => {
        const notifications = notificationService.notifications.read(r)
        for (const notification of notifications) {
          if (this._seenNotifications.has(notification.id)) continue
          this._seenNotifications.add(notification.id)
          if (notification.severity === Severity.Info) continue
          this._recorder.recordEvent({
            kind: 'notification',
            severity: notification.severity === Severity.Error ? 'error' : 'warning',
            message: truncate(notification.message, NOTIFICATION_MAX_LENGTH),
          })
        }
        // The observable holds only live notifications, so a dismissed id can
        // never come back — forgetting it keeps the set bounded by what is on
        // screen instead of by how long the window has been open.
        if (this._seenNotifications.size > notifications.length) {
          const live = new Set(notifications.map((n) => n.id))
          for (const id of this._seenNotifications) {
            if (!live.has(id)) this._seenNotifications.delete(id)
          }
        }
      }),
    )

    this._register(
      autorun((r) => {
        const sessions = acpSessionService.sessions.read(r)
        this._syncAcpSubscriptions(sessions)
      }),
    )

    this._register(
      autorun((r) => {
        const status = this._recorder.status.read(r)
        if (status.state === 'recording' && status.startedAt !== undefined) {
          this._show(status.startedAt)
        } else {
          this._hide()
        }
      }),
    )

    this._register({ dispose: () => this._hide() })
  }

  private _registerModelHooks(): void {
    // DisposableMap, not a plain Map: the per-model stores must be parented to
    // something the leak tracker can root, or every open editor's store is
    // reported as a leak at teardown.
    const modelStores = this._register(new DisposableMap<string, DisposableStore>())
    const attach = (model: MonacoTextModel): void => {
      const key = model.uri.toString()
      if (modelStores.has(key)) return
      const store = new DisposableStore()
      modelStores.set(key, store)
      store.add(
        model.onDidChangeContent(() => {
          if (!this._recorder.isRecording) return
          this._edits.record(key)
        }),
      )
      store.add(
        model.onWillDispose(() => {
          modelStores.deleteAndDispose(key)
        }),
      )
    }

    // Editors restored at startup create their models during the React mount,
    // which happens before AfterRestore contributions exist — so subscribing to
    // onDidAddModel alone would miss exactly the files the user already has open.
    for (const model of MonacoModelRegistry.models()) attach(model)
    this._register(
      MonacoModelRegistry.onDidAddModel((resource) => {
        const model = MonacoModelRegistry.peek(resource)
        if (model !== undefined) attach(model)
      }),
    )
  }

  private _syncAcpSubscriptions(sessions: readonly IAcpSession[]): void {
    this._acpStore.clear()
    const live = new Set(sessions.map((session) => session.id))
    for (const id of this._acpBaselines.keys()) {
      if (!live.has(id)) this._acpBaselines.delete(id)
    }
    for (const session of sessions) {
      this._subscribeAcpSession(session)
    }
  }

  private _subscribeAcpSession(session: IAcpSession): void {
    const timeline: IObservable<readonly TimelineItem[]> = session.timeline
    if (!this._acpBaselines.has(session.id)) {
      this._acpBaselines.set(session.id, timeline.get().length)
    }
    this._acpStore.add(
      autorun((r) => {
        const items = timeline.read(r)
        const seen = this._acpBaselines.get(session.id) ?? 0
        if (items.length <= seen) return
        this._acpBaselines.set(session.id, items.length)
        if (!this._recorder.isRecording) return
        for (const item of items.slice(seen)) {
          this._recordAcpItem(session.id, item)
        }
      }),
    )
  }

  private _recordAcpItem(sessionId: string, item: TimelineItem): void {
    if (item.kind === 'message') {
      this._recorder.recordEvent({
        kind: 'acpMessage',
        sessionId,
        role: item.message.role,
        text: truncate(item.message.text, ACP_MESSAGE_MAX_LENGTH),
      })
      return
    }
    if (item.kind === 'toolCall') {
      const rawInput = item.call.rawInput
      const inputPreview =
        rawInput === undefined
          ? undefined
          : truncate(safeStringify(rawInput), ACP_TOOL_INPUT_MAX_LENGTH)
      this._recorder.recordEvent({
        kind: 'acpToolCall',
        sessionId,
        title: item.call.title,
        status: item.call.status,
        ...(inputPreview !== undefined ? { inputPreview } : {}),
      })
    }
  }

  private _show(startedAt: number): void {
    const render = (): void => {
      const entry = {
        text: `$(record) ${formatElapsed(startedAt, Date.now())}`,
        tooltip: localize(
          'bugRecording.statusTooltip',
          'Recording bug evidence. Click to stop and export.',
        ),
        command: StopBugRecordingAction.ID,
        alignment: StatusBarAlignment.Right,
        priority: 90,
        showProgress: true as const,
        kind: 'prominent' as const,
        backgroundColor: 'statusBarItem.errorBackground',
        id: 'bugRecording',
      }
      if (this._entry) this._entry.update(entry)
      else this._entry = this._statusBarService.addEntry(entry)
    }

    render()
    if (this._ticker === undefined) this._ticker = setInterval(render, 1000)
  }

  private _hide(): void {
    if (this._ticker !== undefined) {
      clearInterval(this._ticker)
      this._ticker = undefined
    }
    // No flush here: by the time the status reads idle, recordEvent would drop
    // whatever the aggregator emits. The flush participant handles it instead.
    this._edits.dispose()
    this._entry?.dispose()
    this._entry = undefined
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  } catch {
    return '(unserializable)'
  }
}
