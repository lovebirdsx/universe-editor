/*---------------------------------------------------------------------------------------------
 *  Tests for RemoteReconnectionUxContribution — the failed-reconnection toast is
 *  deduplicated per authority: the main-side failed → idle → bring-up loop keeps
 *  firing `failed`, but only one toast is shown until the state truly recovers
 *  (`connected`) or the user hits Retry. A user-dismissed toast must not re-pop
 *  while the loop keeps failing; the DTO's errorMessage is surfaced in the text.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  ICommandService,
  ILoggerService,
  INotificationService,
  IWorkspaceService,
  InstantiationService,
  NullLogger,
  REMOTE_SCHEME,
  ServiceCollection,
  Severity,
  URI,
  type INotificationHandle,
  type IPromptChoice,
  type IWorkspace,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  type RemoteConnectionStatusDto,
} from '../../../shared/ipc/remoteStatusService.js'
import { RemoteReconnectionUxContribution } from '../RemoteReconnectionUxContribution.js'
import { CloseConnectionAction, RetryConnectionAction } from '../../actions/remoteActions.js'

const AUTHORITY = 'myhost'

interface Notified {
  readonly id: string
  readonly severity: Severity
  readonly message: string
  readonly actions?: IPromptChoice[]
}

function makeNotificationService() {
  let nextId = 0
  const notified: Notified[] = []
  const dismissed: string[] = []
  const disposed: string[] = []
  return {
    notified,
    dismissed,
    disposed,
    notify(opts: {
      severity: Severity
      message: string
      actions?: IPromptChoice[]
    }): INotificationHandle {
      const id = `n${nextId++}`
      notified.push({
        id,
        severity: opts.severity,
        message: opts.message,
        ...(opts.actions !== undefined ? { actions: opts.actions } : {}),
      })
      return {
        id,
        progress: { report: () => {}, done: () => {} },
        updateMessage: () => {},
        updateSeverity: () => {},
        dispose: () => {
          disposed.push(id)
        },
      }
    },
    dismiss(id: string): void {
      dismissed.push(id)
    },
  }
}

function makeRemoteStatus() {
  const emitter = new Emitter<RemoteConnectionStatusDto>()
  return {
    onDidChangeState: emitter.event,
    _emitter: emitter,
  }
}

function makeWorkspace(authority: string) {
  const emitter = new Emitter<IWorkspace | null>()
  let current: IWorkspace | null = {
    folder: URI.from({ scheme: REMOTE_SCHEME, authority, path: '/' }),
    name: authority,
  }
  return {
    get current() {
      return current
    },
    setCurrent(next: IWorkspace | null) {
      current = next
      emitter.fire(current)
    },
    onDidChangeWorkspace: emitter.event,
    _emitter: emitter,
  }
}

type NotificationSvc = ReturnType<typeof makeNotificationService>
type RemoteStatus = ReturnType<typeof makeRemoteStatus>
type Workspace = ReturnType<typeof makeWorkspace>

interface Harness {
  remoteStatus: RemoteStatus
  workspace: Workspace
  notification: NotificationSvc
  commands: { executeCommand: ReturnType<typeof vi.fn> }
  contribution: RemoteReconnectionUxContribution
}

function setup(): Harness {
  const remoteStatus = makeRemoteStatus()
  const workspace = makeWorkspace(AUTHORITY)
  const notification = makeNotificationService()
  const commands = { executeCommand: vi.fn() }
  const services = new ServiceCollection()
  services.set(IRemoteStatusService, remoteStatus as never)
  services.set(IWorkspaceService, workspace as never)
  services.set(INotificationService, notification as never)
  services.set(ICommandService, commands as never)
  services.set(ILoggerService, { createLogger: () => new NullLogger() } as never)
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(RemoteReconnectionUxContribution)
  return { remoteStatus, workspace, notification, commands, contribution }
}

function fireFailed(remoteStatus: RemoteStatus, errorMessage?: string): void {
  remoteStatus._emitter.fire({
    authority: AUTHORITY,
    state: 'failed',
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  })
}

function fireConnected(remoteStatus: RemoteStatus): void {
  remoteStatus._emitter.fire({ authority: AUTHORITY, state: 'connected' })
}

function errorActions(notification: NotificationSvc): IPromptChoice[] {
  return notification.notified[0]?.actions ?? []
}

describe('RemoteReconnectionUxContribution — failed toast dedup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a single error toast for repeated failed events from the bring-up loop', () => {
    const { remoteStatus, notification } = setup()
    fireFailed(remoteStatus, 'Node.js was not found on the remote host')
    fireFailed(remoteStatus, 'Node.js was not found on the remote host')
    fireFailed(remoteStatus, 'Node.js was not found on the remote host')

    expect(notification.notified).toHaveLength(1)
    expect(notification.notified[0]!.severity).toBe(Severity.Error)
    expect(notification.notified[0]!.message).toContain('myhost')
  })

  it('surfaces the DTO errorMessage so the user sees the real failure reason', () => {
    const { remoteStatus, notification } = setup()
    fireFailed(remoteStatus, 'Node.js was not found on the remote host')

    expect(notification.notified[0]!.message).toContain('Node.js was not found on the remote host')
  })

  it('omits the error detail when the DTO carries no errorMessage', () => {
    const { remoteStatus, notification } = setup()
    fireFailed(remoteStatus)

    expect(notification.notified[0]!.message).toBe('Cannot reconnect to myhost.')
  })

  it('does not re-pop after a user dismissal while the loop keeps failing', () => {
    const { remoteStatus, notification } = setup()
    fireFailed(remoteStatus)

    // The user closes the toast; the underlying loop keeps firing `failed`.
    notification.dismiss(notification.notified[0]!.id)
    fireFailed(remoteStatus)

    expect(notification.notified).toHaveLength(1)
  })

  it('re-arms the toast after a real recovery (connected) then a new failure', () => {
    const { remoteStatus, notification } = setup()
    fireFailed(remoteStatus)
    fireConnected(remoteStatus)
    fireFailed(remoteStatus)

    expect(notification.notified).toHaveLength(2)
  })

  it('dismisses the failed toast when the connection recovers', () => {
    const { remoteStatus, notification } = setup()
    fireFailed(remoteStatus)
    const id = notification.notified[0]!.id

    fireConnected(remoteStatus)

    expect(notification.dismissed).toContain(id)
  })

  it('dismisses the toast and re-arms on Retry so a retry failure surfaces a fresh toast', () => {
    const { remoteStatus, notification, commands } = setup()
    fireFailed(remoteStatus)
    const first = notification.notified[0]!
    const retry = errorActions(notification).find((a) => a.label === 'Retry')
    expect(retry).toBeDefined()

    retry!.run()

    expect(notification.dismissed).toContain(first.id)
    expect(commands.executeCommand).toHaveBeenCalledWith(RetryConnectionAction.ID, AUTHORITY)

    // Retry re-arms the guard: the next failure must produce a new toast.
    fireFailed(remoteStatus)
    expect(notification.notified).toHaveLength(2)
  })

  it('routes Close Remote Workspace through the close-connection command', () => {
    const { remoteStatus, notification, commands } = setup()
    fireFailed(remoteStatus)
    const close = errorActions(notification).find((a) => a.label === 'Close Remote Workspace')
    expect(close).toBeDefined()

    close!.run()

    expect(commands.executeCommand).toHaveBeenCalledWith(CloseConnectionAction.ID, AUTHORITY)
  })

  it('clears the failed toast and its guard on a workspace switch', () => {
    const { remoteStatus, notification, workspace } = setup()
    fireFailed(remoteStatus)
    const id = notification.notified[0]!.id

    workspace.setCurrent(null)

    expect(notification.dismissed).toContain(id)
    // After the switch the authority no longer matches, so no new toast is created.
    fireFailed(remoteStatus)
    expect(notification.notified).toHaveLength(1)
  })
})
