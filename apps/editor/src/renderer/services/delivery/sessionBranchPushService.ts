/**
 * Push a session worktree's branch to its remote. Unlike delivery this never
 * touches main and keeps the original commits; it is the phone's escape hatch
 * for publishing a task branch before a pull request. All git writes stay in
 * the built-in git extension.
 */
import {
  Disposable,
  InstantiationType,
  createDecorator,
  registerSingleton,
} from '@universe-editor/platform'
import type { IAcpSession } from '../acp/session/acpSession.js'
import { isInternalSession } from '../acp/session/acpSessionModel.js'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { ISessionDeliveryGit, deliveryErrorFromGit } from './sessionDeliveryGit.js'
import type {
  DeliveryGitPushExecuteData,
  DeliveryGitPushInspectData,
  DeliveryGitPushRemoteInfo,
  DeliveryGitPushSourceInfo,
} from './sessionDeliveryGit.js'
import { ISessionDeliveryService } from './sessionDeliveryService.js'
import type { SessionDeliveryError } from './sessionDeliveryTypes.js'

export interface SessionBranchPushExpectation {
  readonly branch: string
  readonly head: string
  readonly remote: string
  readonly remoteBranch: string
  readonly remoteHead?: string
}

export interface SessionBranchPushPreview {
  readonly source: DeliveryGitPushSourceInfo
  readonly remote: DeliveryGitPushRemoteInfo
  readonly blockers: readonly SessionDeliveryError[]
  readonly warnings: readonly string[]
  readonly expectation: SessionBranchPushExpectation
}

export type SessionBranchPushResult = DeliveryGitPushExecuteData

export type SessionBranchPushCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SessionDeliveryError }

export interface ISessionBranchPushService {
  readonly _serviceBrand: undefined
  preview(sessionId: string): Promise<SessionBranchPushCommandResult<SessionBranchPushPreview>>
  push(
    sessionId: string,
    expectation: SessionBranchPushExpectation,
  ): Promise<SessionBranchPushCommandResult<SessionBranchPushResult>>
}

export const ISessionBranchPushService = createDecorator<ISessionBranchPushService>(
  'sessionBranchPushService',
)

const failure = (code: SessionDeliveryError['code'], message: string): SessionDeliveryError => ({
  code,
  message,
})

const fromGitFailure = (error: {
  readonly code: string
  readonly message: string
  readonly detail?: string
}): SessionDeliveryError => deliveryErrorFromGit(error)

export class SessionBranchPushService extends Disposable implements ISessionBranchPushService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @ISessionDeliveryGit private readonly _git: ISessionDeliveryGit,
    @ISessionDeliveryService private readonly _delivery: ISessionDeliveryService,
  ) {
    super()
  }

  async preview(
    sessionId: string,
  ): Promise<SessionBranchPushCommandResult<SessionBranchPushPreview>> {
    const session = this._sessions.getById(sessionId)
    const guard = this._guardSession(session)
    if (guard !== undefined) return { ok: false, error: guard }

    const inspected = await this._git.inspectPushBranch({
      sourceCwd: session!.cwd!,
      fetch: true,
    })
    if (!inspected.ok) return { ok: false, error: fromGitFailure(inspected.error) }
    return { ok: true, value: toPreview(inspected) }
  }

  async push(
    sessionId: string,
    expectation: SessionBranchPushExpectation,
  ): Promise<SessionBranchPushCommandResult<SessionBranchPushResult>> {
    const session = this._sessions.getById(sessionId)
    const guard = this._guardSession(session)
    if (guard !== undefined) return { ok: false, error: guard }

    const pushed = await this._git.pushBranch({
      sourceCwd: session!.cwd!,
      expectedBranch: expectation.branch,
      expectedHead: expectation.head,
      remote: expectation.remote,
      remoteBranch: expectation.remoteBranch,
      ...(expectation.remoteHead !== undefined
        ? { expectedRemoteHead: expectation.remoteHead }
        : {}),
      fetch: true,
    })
    if (!pushed.ok) return { ok: false, error: fromGitFailure(pushed.error) }
    return { ok: true, value: pushed }
  }

  private _guardSession(session: IAcpSession | undefined): SessionDeliveryError | undefined {
    if (session === undefined || isInternalSession(session)) {
      return failure('not_found', 'Unknown session.')
    }
    if (session.readOnly) {
      return failure('unsupported', 'A read-only session cannot push its branch.')
    }
    if (session.cwd === undefined || session.cwd.length === 0) {
      return failure('not_a_repository', 'The session has no working directory.')
    }
    if (
      this._delivery.isDeliveryBusyForSession(session) ||
      this._delivery.isDeliveryBusyForCwd(session.cwd, session.authority)
    ) {
      return failure('busy', 'A delivery is running for this repository.')
    }
    const status = session.status.get()
    if (status === 'connecting' || status === 'running') {
      return failure(
        'session_running',
        'The session is still running; wait for it to finish before pushing.',
      )
    }
    return undefined
  }
}

function toPreview(inspected: DeliveryGitPushInspectData): SessionBranchPushPreview {
  return {
    source: inspected.source,
    remote: inspected.remote,
    blockers: inspected.blockers.map(fromGitFailure),
    warnings: inspected.warnings,
    expectation: {
      branch: inspected.source.branch,
      head: inspected.source.head,
      remote: inspected.remote.name,
      remoteBranch: inspected.remote.branch,
      ...(inspected.remote.head !== undefined ? { remoteHead: inspected.remote.head } : {}),
    },
  }
}

registerSingleton(ISessionBranchPushService, SessionBranchPushService, InstantiationType.Delayed)
