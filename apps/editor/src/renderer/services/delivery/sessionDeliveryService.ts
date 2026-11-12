/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session delivery orchestration. Owns the state machine that turns a child
 *  worktree's commits into a main-branch push:
 *
 *    preview → lock → ff-only main → (side task message + commit) → cherry-pick
 *    in a temp worktree → (one conflict-resolution agent pass) → awaiting_push
 *    → confirm → promote + push → sync worktrees.
 *
 *  Safety invariants: never force-push, never stash, never reset a worktree that
 *  has its own commits, and only reset main when it still sits at the expected
 *  commit and is clean. All git writes live in the built-in git extension.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  ILoggerService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationType,
  REMOTE_SCHEME,
  URI,
  createDecorator,
  registerSingleton,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import { MAX_DELIVERY_COMMITS } from '@universe-editor/mobile-protocol'
import type { IAcpSession } from '../acp/session/acpSession.js'
import { isInternalSession } from '../acp/session/acpSessionModel.js'
import { IAcpSessionHistoryService } from '../acp/session/acpSessionHistory.js'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { deleteSideTasks } from '../acp/session/sideTaskRemoval.js'
import {
  DELIVERY_CONFLICT_TIMEOUT_MS,
  DELIVERY_MESSAGE_TIMEOUT_MS,
  buildCommitMessagePrompt,
  buildConflictPrompt,
  runDeliveryTurn,
  sanitizeCommitMessage,
} from './sessionDeliveryCommitMessage.js'
import {
  ISessionDeliveryGit,
  deliveryErrorFromGit,
  type DeliveryGitInspectData,
  type DeliveryGitPickData,
} from './sessionDeliveryGit.js'
import {
  ISessionDeliveryStore,
  MAX_DELIVERIES_PER_REPOSITORY,
  SESSION_DELIVERY_SCHEMA_VERSION,
  sessionDeliveryRepositoryKey,
} from './sessionDeliveryStore.js'
import {
  isActiveDeliveryPhase,
  syncSummary,
  worktreeName,
  type SessionDeliveryChange,
  type SessionDeliveryCommit,
  type SessionDeliveryContext,
  type SessionDeliveryDetail,
  type SessionDeliveryError,
  type SessionDeliveryPreview,
  type SessionDeliveryPreviewResult,
  type SessionDeliveryRecord,
  type SessionDeliveryStartExpectation,
  type SessionDeliveryStartResult,
  type SessionDeliverySummary,
  type SessionDeliveryWorktreeResult,
} from './sessionDeliveryTypes.js'

export type SessionDeliveryCommandResult<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SessionDeliveryError }

export interface ISessionDeliveryService {
  readonly _serviceBrand: undefined
  readonly onDidChange: Event<SessionDeliveryChange>

  /** Load persisted records and reconcile an interrupted delivery (idempotent). */
  initialize(): Promise<void>

  preview(sessionId: string): Promise<SessionDeliveryPreviewResult>
  start(
    sessionId: string,
    expectation: SessionDeliveryStartExpectation,
  ): Promise<SessionDeliveryCommandResult<SessionDeliveryStartResult>>
  confirmPush(deliveryId: string): Promise<SessionDeliveryCommandResult<void>>
  retry(deliveryId: string): Promise<SessionDeliveryCommandResult<void>>
  undo(deliveryId: string): Promise<SessionDeliveryCommandResult<void>>
  openMainWorktree(deliveryId: string): Promise<SessionDeliveryCommandResult<void>>

  getSummaryForSession(localId: string, durableId?: string): SessionDeliverySummary | undefined
  getDetail(deliveryId: string): SessionDeliveryDetail | undefined
  getContext(localId: string, durableId?: string): SessionDeliveryContext | undefined
  getRecord(deliveryId: string): SessionDeliveryRecord | undefined
  /** Every active delivery owned by this window (cross-window guards live in main). */
  listActiveContexts(): readonly SessionDeliveryContext[]

  /** A session row may offer the "deliver" action (idle, or idle-reaped dormant). */
  isAvailable(session: IAcpSession): boolean
  /** Cached worktree check: uncommitted changes or commits main does not reach. */
  hasDeliverableChanges(session: IAcpSession): boolean
  /** Refresh the cached check; resolves true when the visible value changed. */
  refreshDeliverableChanges(
    session: IAcpSession,
    options?: { readonly force?: boolean },
  ): Promise<boolean>
  /** The session's own repo/worktrees are being delivered right now. */
  isDeliveryBusyForSession(session: IAcpSession): boolean
  /** A new prompt rooted at `cwd` on `authority` would race a delivery. */
  isDeliveryBusyForCwd(cwd: string, authority?: string): boolean
}

export const ISessionDeliveryService =
  createDecorator<ISessionDeliveryService>('sessionDeliveryService')

/** How long a worktree probe may be reused before the mobile inbox asks again. */
export const DELIVERABLE_CHANGES_TTL_MS = 10_000
/** Background probes must never pin an in-flight entry forever. */
export const DELIVERABLE_CHANGES_TIMEOUT_MS = 10_000

type RecordPatch = {
  readonly [K in keyof SessionDeliveryRecord]?: SessionDeliveryRecord[K] | undefined
}

interface CommitMessageResult {
  readonly ok: boolean
  readonly head?: string
  readonly commit?: SessionDeliveryCommit
  readonly error?: SessionDeliveryError
}

interface DeliverableChangesEntry {
  value: boolean | undefined
  checkedAt: number
  /** Only the newest probe may write; a forced refresh supersedes an older one. */
  generation: number
  inFlight: Promise<boolean> | undefined
}

interface PickAllResult {
  readonly ok: boolean
  readonly pick?: DeliveryGitPickData
  readonly commits?: readonly SessionDeliveryCommit[]
  readonly skippedEmpty?: readonly string[]
  readonly error?: SessionDeliveryError
}

const HEARTBEAT_INTERVAL_MS = 60_000

function failure(
  code: SessionDeliveryError['code'],
  message: string,
  detail?: string,
): SessionDeliveryError {
  return { code, message, ...(detail !== undefined ? { detail } : {}) }
}

function fromGitFailure(failureValue: {
  readonly code: string
  readonly message: string
  readonly detail?: string
}): SessionDeliveryError {
  return deliveryErrorFromGit(failureValue)
}

function appendDetail(error: SessionDeliveryError, extra: string): SessionDeliveryError {
  return {
    code: error.code,
    message: error.message,
    detail: error.detail !== undefined ? `${error.detail}\n${extra}` : extra,
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function isCodexAgent(agentId: string): boolean {
  return agentId.toLowerCase().includes('codex')
}

function conflictResolutionMode(agentId: string): Readonly<Record<string, string>> {
  return { mode: isCodexAgent(agentId) ? 'workspace-write' : 'acceptEdits' }
}

export class SessionDeliveryService extends Disposable implements ISessionDeliveryService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<SessionDeliveryChange>())
  readonly onDidChange = this._onDidChange.event

  private readonly _records = new Map<string, SessionDeliveryRecord>()
  private readonly _repoRecords = new Map<string, Map<string, SessionDeliveryRecord>>()
  private readonly _heartbeats = new Map<string, ReturnType<typeof setInterval>>()
  private readonly _logger: ILogger
  private readonly _instanceId = globalThis.crypto.randomUUID()
  private _initializePromise: Promise<void> | undefined
  private _writeChain: Promise<void> = Promise.resolve()
  private readonly _deliverableChanges = new Map<string, DeliverableChangesEntry>()
  private readonly _deliverableProbeTimers = new Set<ReturnType<typeof setTimeout>>()
  private _disposed = false

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @ISessionDeliveryGit private readonly _git: ISessionDeliveryGit,
    @ISessionDeliveryStore private readonly _deliveryStore: ISessionDeliveryStore,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'sessionDelivery',
      name: 'Session Delivery',
    })
  }

  initialize(): Promise<void> {
    this._initializePromise ??= this._initialize().catch((err: unknown) => {
      this._logger.warn('failed to load session deliveries', err)
    })
    return this._initializePromise
  }

  async preview(sessionId: string): Promise<SessionDeliveryPreviewResult> {
    await this.initialize()
    const session = this._sessions.getById(sessionId)
    const guard = this._guardSession(session)
    if (guard !== undefined) return { ok: false, error: guard }
    const cwd = session!.cwd!
    const inspected = await this._git.inspect({ sourceCwd: cwd, fetch: true })
    if (!inspected.ok) {
      return { ok: false, error: fromGitFailure(inspected.error) }
    }
    const data = inspected
    const blockers: SessionDeliveryError[] = data.blockers.map(fromGitFailure)
    if (data.commits.length > MAX_DELIVERY_COMMITS) {
      blockers.push(
        failure(
          'unsupported',
          `This delivery contains ${data.commits.length} commits; at most ${MAX_DELIVERY_COMMITS} can be delivered at once.`,
        ),
      )
    }
    const forkSupported = session!.forkSupported.get()
    if (data.source.dirty && !forkSupported) {
      blockers.push(
        failure(
          'unsupported',
          'The source worktree has uncommitted changes, but this agent cannot fork a session to generate a commit message.',
        ),
      )
    }
    const repositoryKey = await sessionDeliveryRepositoryKey(data.repository.commonDir)
    if (this._activeRecordForRepo(repositoryKey) !== undefined) {
      blockers.push(failure('busy', 'Another delivery is already running for this repository.'))
    }
    const target = {
      mainWorktree: data.repository.mainWorktree,
      mainBranch: data.repository.mainBranch,
      targetBranch: data.repository.targetBranch,
      remote: data.repository.remote,
      remoteBranch: data.repository.remoteBranch,
      upstreamRef: data.repository.upstreamRef,
      baseSha: data.baseSha,
      upstreamHead: data.repository.upstreamHead,
      aheadOfUpstream: data.repository.aheadOfUpstream,
    }
    const preview: SessionDeliveryPreview = {
      source: {
        worktree: data.source.worktree,
        ...(data.source.branch !== undefined ? { branch: data.source.branch } : {}),
        head: data.source.head,
        dirty: data.source.dirty,
        changedFileCount: data.source.changedFileCount,
        untrackedCount: data.source.untrackedCount,
        ...(data.source.pendingOperation !== undefined
          ? { pendingOperation: data.source.pendingOperation }
          : {}),
        isMainWorktree: data.source.isMainWorktree,
      },
      target,
      commits: data.commits,
      blockers,
      warnings: data.warnings,
      forkSupported,
      expectation: {
        mainHead: data.repository.mainHead,
        mainBranch: data.repository.mainBranch,
        targetBranch: data.repository.targetBranch,
        remote: data.repository.remote,
        remoteBranch: data.repository.remoteBranch,
        upstreamRef: data.repository.upstreamRef,
        upstreamHead: data.repository.upstreamHead,
        sourceHead: data.source.head,
        baseSha: data.baseSha,
        commits: data.commits.map((commit) => commit.sha),
      },
    }
    return { ok: true, preview }
  }

  async start(
    sessionId: string,
    expectation: SessionDeliveryStartExpectation,
  ): Promise<SessionDeliveryCommandResult<SessionDeliveryStartResult>> {
    await this.initialize()
    const session = this._sessions.getById(sessionId)
    const guard = this._guardSession(session)
    if (guard !== undefined) return { ok: false, error: guard }
    const live = session!
    if (this._activeRecordForSession(live) !== undefined) {
      return { ok: false, error: failure('busy', 'This session already has an active delivery.') }
    }
    if (this._activeRecordForCwd(live.cwd!, live.authority) !== undefined) {
      return {
        ok: false,
        error: failure('busy', 'A delivery is already running for this repository.'),
      }
    }
    const inspected = await this._git.inspect({ sourceCwd: live.cwd!, fetch: true })
    if (!inspected.ok) return { ok: false, error: fromGitFailure(inspected.error) }
    const data = inspected
    const expectationError = this._checkExpectation(expectation, data)
    if (expectationError !== undefined) return { ok: false, error: expectationError }
    if (data.blockers.length > 0) return { ok: false, error: fromGitFailure(data.blockers[0]!) }
    if (data.source.dirty && !live.forkSupported.get()) {
      return {
        ok: false,
        error: failure(
          'unsupported',
          'The source worktree has uncommitted changes, but this agent cannot fork a session to generate a commit message.',
        ),
      }
    }
    const repositoryKey = await sessionDeliveryRepositoryKey(data.repository.commonDir)
    if (this._activeRecordForRepo(repositoryKey) !== undefined) {
      return {
        ok: false,
        error: failure('busy', 'Another delivery is already running for this repository.'),
      }
    }

    const token = globalThis.crypto.randomUUID()
    const deliveryId = globalThis.crypto.randomUUID()
    const lock = await this._git.acquireLock({
      commonDir: data.repository.commonDir,
      token,
      label: live.title,
    })
    if (!lock.ok) return { ok: false, error: fromGitFailure(lock.error) }
    if (!lock.acquired) {
      return {
        ok: false,
        error: failure(
          'lock_held',
          'Another window is delivering this repository. Close or finish that delivery first.',
        ),
      }
    }

    const now = Date.now()
    const durableId = live.sessionIdOnAgent.get()
    let record: SessionDeliveryRecord = {
      id: deliveryId,
      repositoryKey,
      commonDir: data.repository.commonDir,
      phase: 'preflighting',
      createdAt: now,
      updatedAt: now,
      attempt: 1,
      source: {
        sessionLocalId: live.id,
        ...(durableId !== undefined ? { sessionDurableId: durableId } : {}),
        agentId: live.agentId,
        cwd: live.cwd!,
        worktree: data.source.worktree,
        ...(data.source.branch !== undefined ? { branch: data.source.branch } : {}),
        head: data.source.head,
        ...(live.authority !== undefined ? { authority: live.authority } : {}),
      },
      target: {
        mainWorktree: data.repository.mainWorktree,
        mainBranch: data.repository.mainBranch,
        targetBranch: data.repository.targetBranch,
        remote: data.repository.remote,
        remoteBranch: data.repository.remoteBranch,
        upstreamRef: data.repository.upstreamRef,
        baseSha: data.baseSha,
        upstreamHead: data.repository.upstreamHead,
        aheadOfUpstream: data.repository.aheadOfUpstream,
      },
      sourceDirty: data.source.dirty,
      commits: data.commits,
      skippedEmpty: [],
      conflictFiles: [],
      syncResults: [],
      lockToken: token,
      lockInstanceId: this._instanceId,
    }
    this._put(record)
    this._startHeartbeat(record)

    const begin = await this._git.begin({
      commonDir: data.repository.commonDir,
      deliveryId,
      token,
      mainWorktree: data.repository.mainWorktree,
      sourceCwd: data.source.worktree,
      targetBranch: data.repository.targetBranch,
      expectedMainHead: expectation.mainHead,
      expectedUpstreamHead: expectation.upstreamHead,
      expectedSourceHead: expectation.sourceHead,
      remote: data.repository.remote,
      upstreamRef: data.repository.upstreamRef,
    })
    if (!begin.ok) {
      await this._failDelivery(record, fromGitFailure(begin.error))
      return { ok: false, error: fromGitFailure(begin.error) }
    }
    record =
      this._update(record.id, {
        mainHeadBefore: begin.mainHeadBefore,
        mainHeadAfter: begin.mainHeadAfter,
        target: { ...record.target, upstreamHead: begin.upstreamHead, baseSha: data.baseSha },
      }) ?? record

    let sourceHead = data.source.head
    let commits: readonly SessionDeliveryCommit[] = data.commits
    if (data.source.dirty) {
      record = this._update(record.id, { phase: 'committing' }) ?? record
      const generated = await this._generateAndCommit(record, live)
      if (!generated.ok || generated.head === undefined || generated.commit === undefined) {
        await this._failDelivery(
          record,
          generated.error ?? failure('side_task_failed', 'Commit message generation failed.'),
          {
            restoreMain: true,
          },
        )
        return { ok: false, error: generated.error! }
      }
      sourceHead = generated.head
      commits = [...commits, generated.commit]
      record =
        this._update(record.id, {
          generatedMessage: generated.commit.subject,
          commits,
          source: { ...record.source, head: sourceHead },
        }) ?? record
    }

    record = this._update(record.id, { phase: 'cherry_picking' }) ?? record
    const picked = await this._pickAll(
      record,
      sourceHead,
      commits.map((commit) => commit.sha),
    )
    if (!picked.ok || picked.pick === undefined) {
      await this._failDelivery(
        record,
        picked.error ?? failure('git_failed', 'Cherry-picking the delivery failed.'),
        { restoreMain: true, tempWorktree: picked.pick?.tempWorktree },
      )
      return { ok: false, error: picked.error ?? failure('git_failed', 'Cherry-pick failed.') }
    }
    const pick = picked.pick
    record =
      this._update(record.id, {
        phase: 'awaiting_push',
        tempWorktree: pick.tempWorktree,
        tempHead: pick.tempHead,
        commits: picked.commits ?? commits,
        skippedEmpty: picked.skippedEmpty ?? [],
        conflictFiles: [],
      }) ?? record
    this._startHeartbeat(record)
    return { ok: true, value: { deliveryId: record.id } }
  }

  async confirmPush(deliveryId: string): Promise<SessionDeliveryCommandResult<void>> {
    await this.initialize()
    const record = this._records.get(deliveryId)
    if (record === undefined) return { ok: false, error: failure('not_found', 'Unknown delivery.') }
    if (record.phase !== 'awaiting_push' && record.phase !== 'failed') {
      return {
        ok: false,
        error: failure('unsupported', 'This delivery is not waiting to be pushed.'),
      }
    }
    if (record.tempWorktree === undefined || record.tempHead === undefined) {
      return {
        ok: false,
        error: failure('temp_worktree_failed', 'The temporary worktree is no longer available.'),
      }
    }
    const locked = await this._ensureLock(record)
    if (!locked.ok) return { ok: false, error: locked.error! }
    let current = locked.record
    const tempWorktree = record.tempWorktree
    const tempHead = record.tempHead
    current = this._update(current.id, { phase: 'pushing', error: undefined }) ?? current
    const promoted = await this._git.promoteAndPush({
      commonDir: current.commonDir,
      deliveryId: current.id,
      token: current.lockToken!,
      mainWorktree: current.target.mainWorktree,
      targetBranch: current.target.targetBranch,
      baseSha: current.target.baseSha,
      tempWorktree,
      tempHead,
      remote: current.target.remote,
      upstreamRef: current.target.upstreamRef,
    })
    if (!promoted.ok) {
      const error = fromGitFailure(promoted.error)
      await this._releaseLock(current)
      // Keep the temp worktree: the extension restores main to the base commit,
      // so the user can retry the push from the delivery detail.
      current = this._update(current.id, { phase: 'failed', error }) ?? current
      return { ok: false, error }
    }
    current =
      this._update(current.id, {
        pushedSha: promoted.pushedSha,
        remoteRef: promoted.remoteRef,
        phase: 'syncing',
        tempWorktree: undefined,
        tempHead: undefined,
      }) ?? current
    const syncError = await this._syncRecord(current)
    if (syncError !== undefined) return { ok: false, error: syncError }
    return { ok: true, value: undefined }
  }

  async retry(deliveryId: string): Promise<SessionDeliveryCommandResult<void>> {
    await this.initialize()
    const record = this._records.get(deliveryId)
    if (record === undefined) return { ok: false, error: failure('not_found', 'Unknown delivery.') }
    if (record.failedAction === 'undo') {
      return this.undo(deliveryId)
    }
    if (record.pushedSha !== undefined) {
      const locked = await this._ensureLock(record)
      if (!locked.ok) return { ok: false, error: locked.error! }
      const current =
        this._update(locked.record.id, { phase: 'syncing', error: undefined }) ?? locked.record
      const error = await this._syncRecord(current)
      return error === undefined ? { ok: true, value: undefined } : { ok: false, error }
    }
    if (record.phase !== 'failed') {
      return {
        ok: false,
        error: failure('unsupported', 'Only a failed delivery can be retried.'),
      }
    }
    // A failed push keeps the temp worktree; retry the push instead of creating
    // a second delivery whose temporary worktree would be left behind.
    if (record.tempWorktree !== undefined && record.tempHead !== undefined) {
      return this.confirmPush(deliveryId)
    }
    const session = await this._resolveSourceSession(record)
    if (session === undefined) {
      return {
        ok: false,
        error: failure('not_found', 'The source session is no longer available.'),
      }
    }
    await this._releaseLock(record)
    const preview = await this.preview(session.id)
    if (!preview.ok) return { ok: false, error: preview.error }
    if (preview.preview.blockers.length > 0) {
      return { ok: false, error: preview.preview.blockers[0]! }
    }
    const started = await this.start(session.id, preview.preview.expectation)
    return started.ok ? { ok: true, value: undefined } : started
  }

  async undo(deliveryId: string): Promise<SessionDeliveryCommandResult<void>> {
    await this.initialize()
    const record = this._records.get(deliveryId)
    if (record === undefined) return { ok: false, error: failure('not_found', 'Unknown delivery.') }
    if (record.undo !== undefined) {
      return { ok: false, error: failure('unsupported', 'This delivery was already undone.') }
    }
    if (record.phase === 'failed' && record.failedAction === 'undo') {
      this._update(record.id, { failedAction: undefined, error: undefined })
    }
    const locked = await this._ensureLock(record)
    if (!locked.ok) return { ok: false, error: locked.error! }
    let current =
      this._update(locked.record.id, { phase: 'undoing', error: undefined }) ?? locked.record

    if (current.pushedSha === undefined) {
      if (current.tempWorktree !== undefined) {
        await this._git.abortPick({
          commonDir: current.commonDir,
          deliveryId: current.id,
          token: current.lockToken!,
          mainWorktree: current.target.mainWorktree,
          tempWorktree: current.tempWorktree,
        })
      }
      const restored = await this._restoreMain(current)
      await this._releaseLock(current)
      if (restored !== undefined) {
        current = this._update(current.id, { phase: 'failed', error: restored }) ?? current
        return { ok: false, error: restored }
      }
      const undo = {
        at: Date.now(),
        revertedShas: [],
        mainHead: current.mainHeadBefore ?? current.target.baseSha,
      }
      this._update(current.id, {
        phase: 'undone',
        undo,
        tempWorktree: undefined,
        tempHead: undefined,
        conflictFiles: [],
      })
      return { ok: true, value: undefined }
    }

    const undone = await this._git.undo({
      commonDir: current.commonDir,
      deliveryId: current.id,
      token: current.lockToken!,
      mainWorktree: current.target.mainWorktree,
      targetBranch: current.target.targetBranch,
      pushedSha: current.pushedSha,
      deliveredShas: current.commits.map((commit) => commit.sha),
      remote: current.target.remote,
      upstreamRef: current.target.upstreamRef,
    })
    if (!undone.ok) {
      const error = fromGitFailure(undone.error)
      await this._releaseLock(current)
      this._update(current.id, { phase: 'failed', error, failedAction: 'undo' })
      return { ok: false, error }
    }
    current =
      this._update(current.id, {
        phase: 'syncing',
        undo: {
          at: Date.now(),
          revertedShas: undone.revertedShas,
          mainHead: undone.mainHead,
        },
      }) ?? current
    const syncError = await this._syncRecord(current, undone.mainHead, 'undone')
    if (syncError !== undefined) return { ok: false, error: syncError }
    return { ok: true, value: undefined }
  }

  async openMainWorktree(deliveryId: string): Promise<SessionDeliveryCommandResult<void>> {
    await this.initialize()
    const record = this._records.get(deliveryId)
    if (record === undefined) return { ok: false, error: failure('not_found', 'Unknown delivery.') }
    const authority = record.source.authority
    const folder =
      authority !== undefined && authority.length > 0
        ? URI.from({ scheme: REMOTE_SCHEME, authority, path: record.target.mainWorktree })
        : URI.file(record.target.mainWorktree)
    try {
      await this._workspace.openFolder(folder)
      return { ok: true, value: undefined }
    } catch (err) {
      return {
        ok: false,
        error: failure(
          'git_failed',
          'Opening the main worktree failed.',
          err instanceof Error ? err.message : String(err),
        ),
      }
    }
  }

  getSummaryForSession(localId: string, durableId?: string): SessionDeliverySummary | undefined {
    const record = this._recordForSession(localId, durableId)
    return record !== undefined ? this._summary(record) : undefined
  }

  getDetail(deliveryId: string): SessionDeliveryDetail | undefined {
    const record = this._records.get(deliveryId)
    if (record === undefined) return undefined
    return {
      summary: this._summary(record),
      source: {
        worktreeName: worktreeName(record.source.worktree),
        ...(record.source.branch !== undefined ? { branch: record.source.branch } : {}),
        head: record.source.head,
        dirty: record.sourceDirty,
      },
      target: {
        mainWorktreeName: worktreeName(record.target.mainWorktree),
        mainBranch: record.target.mainBranch,
        remote: record.target.remote,
        remoteBranch: record.target.remoteBranch,
        upstreamRef: record.target.upstreamRef,
        baseSha: record.target.baseSha,
        mainHead: record.mainHeadAfter ?? record.target.baseSha,
      },
      commits: record.commits,
      ...(record.generatedMessage !== undefined
        ? { generatedMessage: record.generatedMessage }
        : {}),
      conflictFiles: record.conflictFiles,
      ...(record.conflictedCommit !== undefined
        ? { conflictedCommit: record.conflictedCommit }
        : {}),
      ...(record.pushedSha !== undefined ? { pushedSha: record.pushedSha } : {}),
      ...(record.remoteRef !== undefined ? { remoteRef: record.remoteRef } : {}),
      syncResults: record.syncResults,
      ...(record.undo !== undefined ? { undo: record.undo } : {}),
    }
  }

  getContext(localId: string, durableId?: string): SessionDeliveryContext | undefined {
    const record = this._recordForSession(localId, durableId)
    return record !== undefined ? this._contextOf(record) : undefined
  }

  getRecord(deliveryId: string): SessionDeliveryRecord | undefined {
    return this._records.get(deliveryId)
  }

  listActiveContexts(): readonly SessionDeliveryContext[] {
    const contexts: SessionDeliveryContext[] = []
    for (const record of this._records.values()) {
      if (isActiveDeliveryPhase(record.phase)) contexts.push(this._contextOf(record))
    }
    return contexts
  }

  private _contextOf(record: SessionDeliveryRecord): SessionDeliveryContext {
    return {
      sourceCwd: record.source.cwd,
      ...(record.source.authority !== undefined ? { authority: record.source.authority } : {}),
      deliveryId: record.id,
      phase: record.phase,
      mainWorktree: record.target.mainWorktree,
    }
  }

  isAvailable(session: IAcpSession): boolean {
    const status = session.status.get()
    // An idle-reaped session is dormant (`closed` + isDormant): the agent
    // process is gone, but delivery only needs it to generate a commit message
    // for a dirty source, and forkSideTask wakes the session on demand.
    const idleOrDormant = status === 'idle' || (status === 'closed' && session.isDormant.get())
    return (
      !isInternalSession(session) &&
      !session.readOnly &&
      session.cwd !== undefined &&
      session.cwd.length > 0 &&
      idleOrDormant &&
      session.pendingPermission.get() === undefined &&
      session.pendingElicitation.get() === undefined
    )
  }

  hasDeliverableChanges(session: IAcpSession): boolean {
    const cwd = session.cwd
    if (cwd === undefined || cwd.length === 0) return false
    const entry = this._deliverableChanges.get(this._deliverableChangesKey(cwd, session.authority))
    return entry?.value === true
  }

  refreshDeliverableChanges(
    session: IAcpSession,
    options?: { readonly force?: boolean },
  ): Promise<boolean> {
    if (this._disposed) return Promise.resolve(false)
    const cwd = session.cwd
    if (cwd === undefined || cwd.length === 0) return Promise.resolve(false)
    const key = this._deliverableChangesKey(cwd, session.authority)
    const force = options?.force === true
    const existing = this._deliverableChanges.get(key)
    const entry: DeliverableChangesEntry = existing ?? {
      value: undefined,
      checkedAt: 0,
      generation: 0,
      inFlight: undefined,
    }
    if (existing === undefined) this._deliverableChanges.set(key, entry)
    if (!force) {
      if (entry.inFlight !== undefined) return entry.inFlight
      if (entry.value !== undefined && Date.now() - entry.checkedAt < DELIVERABLE_CHANGES_TTL_MS) {
        return Promise.resolve(false)
      }
    }
    const generation = ++entry.generation
    const before = entry.value === true
    const probe = this._probeDeliverableChanges(cwd).then((value) => {
      if (this._disposed || entry.generation !== generation) return false
      const after = value === true
      entry.value = value
      entry.checkedAt = Date.now()
      entry.inFlight = undefined
      return before !== after
    })
    entry.inFlight = probe
    return probe
  }

  private _probeDeliverableChanges(cwd: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const state: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined }
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        if (state.timer !== undefined) {
          clearTimeout(state.timer)
          this._deliverableProbeTimers.delete(state.timer)
        }
        resolve(value)
      }
      state.timer = setTimeout(() => finish(false), DELIVERABLE_CHANGES_TIMEOUT_MS)
      this._deliverableProbeTimers.add(state.timer)
      this._git.hasPendingWork({ sourceCwd: cwd }).then(
        (result) => finish(result.ok && result.pending === true),
        () => finish(false),
      )
    })
  }

  private _deliverableChangesKey(cwd: string, authority: string | undefined): string {
    return `${authority ?? ''}|${this._uriIdentity.getPathComparisonKey(cwd)}`
  }

  isDeliveryBusyForSession(session: IAcpSession): boolean {
    return this._activeRecordForSession(session) !== undefined
  }

  isDeliveryBusyForCwd(cwd: string, authority?: string): boolean {
    return this._activeRecordForCwd(cwd, authority) !== undefined
  }

  override dispose(): void {
    this._disposed = true
    for (const timer of this._deliverableProbeTimers) clearTimeout(timer)
    this._deliverableProbeTimers.clear()
    this._deliverableChanges.clear()
    for (const timer of this._heartbeats.values()) clearInterval(timer)
    this._heartbeats.clear()
    super.dispose()
  }

  private async _initialize(): Promise<void> {
    const keys = await this._deliveryStore.listRepositoryKeys()
    for (const key of keys) {
      const state = await this._deliveryStore.readRepository(key)
      if (state === undefined) continue
      const map = new Map<string, SessionDeliveryRecord>()
      for (const record of state.records) {
        map.set(record.id, record)
        this._records.set(record.id, record)
      }
      this._repoRecords.set(key, map)
    }
    for (const map of this._repoRecords.values()) {
      for (const record of [...map.values()]) {
        if (!isActiveDeliveryPhase(record.phase)) continue
        await this._reconcile(record)
      }
    }
    for (const record of [...this._records.values()]) {
      if (record.phase === 'failed' || record.phase === 'partial') {
        await this._restoreSourceSession(record)
      }
    }
  }

  private async _reconcile(record: SessionDeliveryRecord): Promise<void> {
    const locked = await this._ensureLock(record)
    if (!locked.ok) {
      // Another live window owns this delivery; leave its record untouched.
      if (locked.busy === true) return
      this._update(record.id, {
        phase: 'failed',
        error: locked.error,
        tempWorktree: undefined,
        tempHead: undefined,
      })
      return
    }
    let current = locked.record
    switch (current.phase) {
      case 'awaiting_push': {
        this._startHeartbeat(current)
        if (!(await this._restoreSourceSession(current))) {
          await this._failDelivery(
            current,
            failure(
              'not_found',
              'The source session was removed; the delivery can no longer be confirmed from the phone.',
            ),
            current.tempWorktree !== undefined ? { tempWorktree: current.tempWorktree } : {},
          )
        }
        return
      }
      case 'pushing': {
        const state = await this._remoteDeliveryState(current)
        if (state === 'pushed') {
          current =
            this._update(current.id, {
              phase: 'syncing',
              pushedSha: current.tempHead,
              tempWorktree: undefined,
              tempHead: undefined,
            }) ?? current
          await this._syncRecord(current)
          return
        }
        if (state === 'local_only') {
          // Main was moved to the delivery commit but the push never proved
          // successful. Keep the temp worktree and wait for the user to retry.
          current =
            this._update(current.id, {
              phase: 'awaiting_push',
              pushedSha: undefined,
              error: undefined,
            }) ?? current
          this._startHeartbeat(current)
          if (!(await this._restoreSourceSession(current))) {
            await this._failDelivery(
              current,
              failure(
                'not_found',
                'The source session was removed; the delivery can no longer be confirmed from the phone.',
              ),
              current.tempWorktree !== undefined ? { tempWorktree: current.tempWorktree } : {},
            )
          }
          return
        }
        await this._failDelivery(
          current,
          failure(
            'push_failed',
            state === 'unknown'
              ? 'The app restarted during the push and the remote state could not be verified. Check the remote branch before retrying.'
              : 'The app restarted during the push and main no longer holds the delivery. Verify the remote branch before retrying.',
          ),
          current.tempWorktree !== undefined ? { tempWorktree: current.tempWorktree } : {},
        )
        return
      }
      case 'syncing': {
        current =
          this._update(current.id, {
            phase: 'syncing',
            pushedSha: current.pushedSha ?? current.tempHead,
            tempWorktree: undefined,
            tempHead: undefined,
          }) ?? current
        await this._syncRecord(current)
        return
      }
      default: {
        const temp = current.tempWorktree
        if (temp !== undefined) {
          await this._git.abortPick({
            commonDir: current.commonDir,
            deliveryId: current.id,
            token: current.lockToken!,
            mainWorktree: current.target.mainWorktree,
            tempWorktree: temp,
          })
        }
        await this._failDelivery(
          current,
          failure(
            'git_failed',
            'The app restarted while the delivery was running; the temporary worktree was removed.',
          ),
          { restoreMain: true },
        )
        return
      }
    }
  }

  private async _remoteDeliveryState(
    record: SessionDeliveryRecord,
  ): Promise<'pushed' | 'local_only' | 'lost' | 'unknown'> {
    if (record.tempHead === undefined) return 'lost'
    const inspected = await this._git.inspect({
      sourceCwd: record.target.mainWorktree,
      fetch: true,
    })
    if (!inspected.ok) return 'unknown'
    if (inspected.repository.upstreamHead === record.tempHead) return 'pushed'
    if (inspected.repository.mainHead === record.tempHead) return 'local_only'
    return 'lost'
  }

  private async _restoreSourceSession(record: SessionDeliveryRecord): Promise<boolean> {
    const localId = record.source.sessionLocalId
    if (localId !== undefined && this._sessions.getById(localId) !== undefined) return true
    const durableId = record.source.sessionDurableId
    if (durableId === undefined) return localId !== undefined
    if (this._sessions.getById(durableId) !== undefined) return true
    if (this._history.get(durableId) === undefined) return false
    try {
      await this._sessions.resumeSession(durableId, { activate: false })
      return true
    } catch (err) {
      this._logger.warn(`failed to resume source session ${durableId}`, err)
      return false
    }
  }

  private _guardSession(session: IAcpSession | undefined): SessionDeliveryError | undefined {
    if (session === undefined) return failure('not_found', 'Unknown session.')
    if (isInternalSession(session)) return failure('not_found', 'Unknown session.')
    if (session.readOnly) {
      return failure('unsupported', 'A read-only session cannot be delivered.')
    }
    if (session.cwd === undefined || session.cwd.length === 0) {
      return failure('not_a_repository', 'The session has no working directory.')
    }
    return undefined
  }

  private _checkExpectation(
    expectation: SessionDeliveryStartExpectation,
    data: DeliveryGitInspectData,
  ): SessionDeliveryError | undefined {
    if (
      expectation.mainBranch !== data.repository.mainBranch ||
      expectation.targetBranch !== data.repository.targetBranch ||
      expectation.remote !== data.repository.remote ||
      expectation.remoteBranch !== data.repository.remoteBranch ||
      expectation.upstreamRef !== data.repository.upstreamRef
    ) {
      return failure('upstream_changed', 'The upstream configuration changed since the preview.')
    }
    if (expectation.upstreamHead !== data.repository.upstreamHead) {
      return failure('upstream_changed', 'The remote main branch moved since the preview.')
    }
    if (expectation.baseSha !== data.baseSha) {
      return failure('upstream_changed', 'The delivery base changed since the preview.')
    }
    if (expectation.mainHead !== data.repository.mainHead) {
      return failure('main_moved', 'The main branch moved since the preview.')
    }
    if (expectation.sourceHead !== data.source.head) {
      return failure('head_mismatch', 'The source worktree moved since the preview.')
    }
    if (
      !sameStrings(
        expectation.commits,
        data.commits.map((commit) => commit.sha),
      )
    ) {
      return failure('upstream_changed', 'The commit list changed since the preview.')
    }
    return undefined
  }

  private async _generateAndCommit(
    record: SessionDeliveryRecord,
    session: IAcpSession,
  ): Promise<CommitMessageResult> {
    const context = await this._git.changeContext({ sourceWorktree: record.source.worktree })
    if (!context.ok) return { ok: false, error: fromGitFailure(context.error) }
    let sideTask: IAcpSession
    try {
      sideTask = await this._sessions.forkSideTask(session.id, undefined, { internal: true })
    } catch (err) {
      return {
        ok: false,
        error: failure(
          'side_task_failed',
          'Creating the commit-message side task failed.',
          err instanceof Error ? err.message : String(err),
        ),
      }
    }
    try {
      const turn = await runDeliveryTurn(
        sideTask,
        buildCommitMessagePrompt(context),
        DELIVERY_MESSAGE_TIMEOUT_MS,
        'side_task_failed',
        'Commit message generation',
      )
      if (!turn.ok) return { ok: false, error: turn.error }
      const message = sanitizeCommitMessage(turn.text)
      if (message === undefined) {
        return {
          ok: false,
          error: failure(
            'invalid_message',
            'The agent returned an empty or oversized commit message.',
          ),
        }
      }
      const after = await this._git.changeContext({ sourceWorktree: record.source.worktree })
      if (!after.ok) return { ok: false, error: fromGitFailure(after.error) }
      if (after.fingerprint !== context.fingerprint) {
        return {
          ok: false,
          error: failure(
            'source_changed',
            'The source worktree changed while the commit message was generated.',
          ),
        }
      }
      const committed = await this._git.commitSource({
        commonDir: record.commonDir,
        deliveryId: record.id,
        token: record.lockToken!,
        sourceWorktree: record.source.worktree,
        expectedSourceHead: record.source.head,
        message,
      })
      if (!committed.ok) return { ok: false, error: fromGitFailure(committed.error) }
      return { ok: true, head: committed.head, commit: committed.commit }
    } finally {
      await deleteSideTasks([sideTask.id], this._sessions, this._history).catch((err: unknown) =>
        this._logger.warn('failed to delete the delivery side task', err),
      )
    }
  }

  private async _pickAll(
    record: SessionDeliveryRecord,
    sourceHead: string,
    commitShas: readonly string[],
  ): Promise<PickAllResult> {
    if (commitShas.length === 0) {
      return {
        ok: false,
        error: failure('nothing_to_deliver', 'The source worktree has nothing to deliver.'),
      }
    }
    const commonDir = record.commonDir
    const prepared = await this._git.preparePick({
      commonDir,
      deliveryId: record.id,
      token: record.lockToken!,
      mainWorktree: record.target.mainWorktree,
      sourceWorktree: record.source.worktree,
      baseSha: record.target.baseSha,
      sourceHead,
      commits: commitShas,
    })
    if (!prepared.ok) {
      // Prepare may have died after creating the temp worktree (e.g. the
      // extension host was restarted mid-pick). The git extension derives the
      // path from the delivery id, so the leftover is still removed.
      await this._git.abortPick({
        commonDir,
        deliveryId: record.id,
        token: record.lockToken!,
        mainWorktree: record.target.mainWorktree,
      })
      return { ok: false, error: fromGitFailure(prepared.error) }
    }
    if (prepared.status === 'picked') {
      return {
        ok: true,
        pick: prepared,
        commits: prepared.picked,
        skippedEmpty: prepared.skippedEmpty,
      }
    }

    // One conflict-resolution attempt. The resolver agent may only edit files in
    // the temporary worktree; any second conflict aborts the delivery.
    const updated =
      this._update(record.id, {
        phase: 'resolving_conflict',
        tempWorktree: prepared.tempWorktree,
        tempHead: prepared.tempHead,
        conflictFiles: prepared.conflictFiles,
        ...(prepared.conflictedCommit !== undefined
          ? { conflictedCommit: prepared.conflictedCommit }
          : {}),
      }) ?? record
    const resolved = await this._resolveConflict(updated, prepared)
    if (!resolved.ok) {
      await this._git.abortPick({
        commonDir,
        deliveryId: record.id,
        token: record.lockToken!,
        mainWorktree: record.target.mainWorktree,
        tempWorktree: prepared.tempWorktree,
      })
      return { ok: false, error: resolved.error }
    }
    const continued = await this._git.continuePick({
      commonDir,
      deliveryId: record.id,
      token: record.lockToken!,
      mainWorktree: record.target.mainWorktree,
      tempWorktree: prepared.tempWorktree,
      remainingCommits: prepared.remainingCommits,
      conflictFiles: prepared.conflictFiles,
      expectedTempHead: prepared.tempHead,
    })
    if (!continued.ok) {
      await this._git.abortPick({
        commonDir,
        deliveryId: record.id,
        token: record.lockToken!,
        mainWorktree: record.target.mainWorktree,
        tempWorktree: prepared.tempWorktree,
      })
      return { ok: false, error: fromGitFailure(continued.error) }
    }
    if (continued.status === 'conflict') {
      await this._git.abortPick({
        commonDir,
        deliveryId: record.id,
        token: record.lockToken!,
        mainWorktree: record.target.mainWorktree,
        tempWorktree: prepared.tempWorktree,
      })
      return {
        ok: false,
        error: failure(
          'conflict',
          'The cherry-pick still conflicts after one agent pass.',
          continued.conflictFiles.join('\n'),
        ),
      }
    }
    const commits = [...prepared.picked, ...continued.picked]
    return {
      ok: true,
      pick: { ...continued, picked: commits, remainingCommits: [] },
      commits,
      skippedEmpty: [...prepared.skippedEmpty, ...continued.skippedEmpty],
    }
  }

  private async _resolveConflict(
    record: SessionDeliveryRecord,
    pick: DeliveryGitPickData,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: SessionDeliveryError }> {
    const conflicted = pick.conflictedCommit
    if (conflicted === undefined) {
      return { ok: false, error: failure('conflict', 'The conflicting commit is unknown.') }
    }
    let resolver: IAcpSession
    try {
      resolver = await this._sessions.createSession(this._sourceAgentId(record), {
        cwd: pick.tempWorktree,
        ...(record.source.authority !== undefined ? { authority: record.source.authority } : {}),
        title: 'Delivery conflict resolution',
        internal: true,
        internalWritable: true,
        activate: false,
        configDesiredOverrides: conflictResolutionMode(this._sourceAgentId(record)),
      })
    } catch (err) {
      return {
        ok: false,
        error: failure(
          'conflict',
          'Creating the conflict-resolution session failed.',
          err instanceof Error ? err.message : String(err),
        ),
      }
    }
    try {
      const prompt = buildConflictPrompt({
        conflictedCommit: conflicted,
        files: pick.conflictFiles,
        remainingCommits: Math.max(0, pick.remainingCommits.length - 1),
      })
      const turn = await runDeliveryTurn(
        resolver,
        prompt,
        DELIVERY_CONFLICT_TIMEOUT_MS,
        'conflict',
        'Conflict resolution',
      )
      if (!turn.ok) return { ok: false, error: turn.error }
      return { ok: true }
    } finally {
      await deleteSideTasks([resolver.id], this._sessions, this._history).catch(() => undefined)
    }
  }

  private _sourceAgentId(record: SessionDeliveryRecord): string {
    return record.source.agentId
  }

  private async _syncRecord(
    record: SessionDeliveryRecord,
    newHead?: string,
    successPhase: 'synced' | 'undone' = 'synced',
  ): Promise<SessionDeliveryError | undefined> {
    const head = newHead ?? record.pushedSha ?? record.tempHead
    if (head === undefined) {
      const error = failure('git_failed', 'The delivered commit is unknown; cannot sync worktrees.')
      await this._releaseLock(record)
      this._update(record.id, { phase: 'failed', error })
      return error
    }
    const synced = await this._git.syncWorktrees({
      commonDir: record.commonDir,
      deliveryId: record.id,
      token: record.lockToken!,
      mainWorktree: record.target.mainWorktree,
      newHead: head,
      sourceWorktree: record.source.worktree,
      expectedSourceHead: record.source.head,
      ...(record.tempWorktree !== undefined ? { tempWorktree: record.tempWorktree } : {}),
    })
    await this._releaseLock(record)
    if (!synced.ok) {
      const error = fromGitFailure(synced.error)
      this._update(record.id, { phase: 'failed', error, syncResults: [] })
      return error
    }
    const results: readonly SessionDeliveryWorktreeResult[] = synced.results.map((result) => ({
      name: result.name,
      ...(result.branch !== undefined ? { branch: result.branch } : {}),
      status: result.status,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }))
    const summary = syncSummary(results)
    const sourceResult = synced.results.find((result) =>
      this._uriIdentity.arePathsEqual(result.path, record.source.worktree),
    )
    const sourceSynced = sourceResult?.status === 'synced' || sourceResult?.status === 'up_to_date'
    this._update(record.id, {
      phase: summary.failed > 0 ? 'partial' : successPhase,
      syncResults: results,
      ...(sourceSynced ? { source: { ...record.source, head } } : {}),
    })
    return undefined
  }

  private async _failDelivery(
    record: SessionDeliveryRecord,
    error: SessionDeliveryError,
    options: {
      readonly restoreMain?: boolean
      readonly tempWorktree?: string | undefined
    } = {},
  ): Promise<void> {
    let current = record
    let finalError = error
    if (options.tempWorktree !== undefined) {
      await this._git.abortPick({
        commonDir: current.commonDir,
        deliveryId: current.id,
        token: current.lockToken!,
        mainWorktree: current.target.mainWorktree,
        tempWorktree: options.tempWorktree,
      })
      current =
        this._update(current.id, { tempWorktree: undefined, tempHead: undefined }) ?? current
    }
    if (options.restoreMain === true) {
      const restoreError = await this._restoreMain(current)
      if (restoreError !== undefined) {
        finalError = appendDetail(finalError, restoreError.message)
      }
    }
    await this._releaseLock(current)
    this._update(current.id, {
      phase: 'failed',
      error: finalError,
      tempWorktree: undefined,
      tempHead: undefined,
      conflictFiles: [],
    })
  }

  private async _restoreMain(
    record: SessionDeliveryRecord,
  ): Promise<SessionDeliveryError | undefined> {
    const before = record.mainHeadBefore
    const after = record.mainHeadAfter
    if (before === undefined || after === undefined || before === after) return undefined
    const restored = await this._git.restoreMain({
      mainWorktree: record.target.mainWorktree,
      expectedCurrentHead: after,
      restoreToHead: before,
      targetBranch: record.target.targetBranch,
    })
    if (restored.ok) return undefined
    return appendDetail(
      fromGitFailure(restored.error),
      'Restoring the main branch to its pre-delivery commit failed; check it manually.',
    )
  }

  private async _ensureLock(record: SessionDeliveryRecord): Promise<{
    readonly ok: boolean
    readonly record: SessionDeliveryRecord
    /** The lock is held by another live window running this same delivery. */
    readonly busy?: boolean
    readonly error?: SessionDeliveryError
  }> {
    const token = record.lockToken
    if (token !== undefined && record.lockInstanceId === this._instanceId) {
      const alive = await this._git.heartbeatLock({
        commonDir: record.commonDir,
        token,
      })
      if (alive.ok) return { ok: true, record }
    }
    // A token persisted by another window must never be reused here: acquiring a
    // fresh one either takes over a stale lock or reports who still owns it.
    const newToken = globalThis.crypto.randomUUID()
    const acquired = await this._git.acquireLock({
      commonDir: record.commonDir,
      token: newToken,
      label: `delivery ${record.id}`,
    })
    if (!acquired.ok) {
      return { ok: false, record, error: fromGitFailure(acquired.error) }
    }
    if (!acquired.acquired) {
      const otherWindow = acquired.owner !== undefined && acquired.owner.token === record.lockToken
      return {
        ok: false,
        record,
        ...(otherWindow ? { busy: true } : {}),
        error: failure(
          'lock_held',
          otherWindow
            ? 'Another window is still running this delivery.'
            : 'Another delivery holds the lock for this repository.',
        ),
      }
    }
    const next = this._update(record.id, {
      lockToken: newToken,
      lockInstanceId: this._instanceId,
    }) ?? { ...record, lockToken: newToken, lockInstanceId: this._instanceId }
    return { ok: true, record: next }
  }

  private async _releaseLock(record: SessionDeliveryRecord): Promise<void> {
    this._stopHeartbeat(record.id)
    const token = record.lockToken
    if (token === undefined) return
    await this._git.releaseLock({ commonDir: record.commonDir, token })
    this._update(record.id, { lockToken: undefined, lockInstanceId: undefined })
  }

  private _startHeartbeat(record: SessionDeliveryRecord): void {
    if (this._heartbeats.has(record.id)) return
    const timer = setInterval(() => {
      const current = this._records.get(record.id)
      const token = current?.lockToken
      if (current === undefined || token === undefined) {
        this._stopHeartbeat(record.id)
        return
      }
      void this._git.heartbeatLock({ commonDir: current.commonDir, token }).catch(() => undefined)
    }, HEARTBEAT_INTERVAL_MS)
    this._heartbeats.set(record.id, timer)
  }

  private _stopHeartbeat(deliveryId: string): void {
    const timer = this._heartbeats.get(deliveryId)
    if (timer !== undefined) clearInterval(timer)
    this._heartbeats.delete(deliveryId)
  }

  private _recordForSession(
    localId: string,
    durableId?: string,
  ): SessionDeliveryRecord | undefined {
    let best: SessionDeliveryRecord | undefined
    for (const record of this._records.values()) {
      const matchesLocal = record.source.sessionLocalId === localId
      const matchesDurable = durableId !== undefined && record.source.sessionDurableId === durableId
      if (!matchesLocal && !matchesDurable) continue
      if (best === undefined || record.updatedAt > best.updatedAt) best = record
    }
    return best
  }

  private _activeRecordForSession(session: IAcpSession): SessionDeliveryRecord | undefined {
    return this._activeRecordForSessionIds(
      session.id,
      session.sessionIdOnAgent.get(),
      session.cwd,
      session.authority,
    )
  }

  private _activeRecordForSessionIds(
    localId: string,
    durableId: string | undefined,
    cwd: string | undefined,
    authority: string | undefined,
  ): SessionDeliveryRecord | undefined {
    for (const record of this._records.values()) {
      if (!isActiveDeliveryPhase(record.phase)) continue
      if (
        record.source.sessionLocalId === localId ||
        (durableId !== undefined && record.source.sessionDurableId === durableId)
      ) {
        return record
      }
      if (
        cwd !== undefined &&
        this._samePath(cwd, record.source.worktree) &&
        authority === record.source.authority
      ) {
        return record
      }
    }
    return undefined
  }

  private _activeRecordForCwd(
    cwd: string,
    authority: string | undefined,
  ): SessionDeliveryRecord | undefined {
    for (const record of this._records.values()) {
      if (!isActiveDeliveryPhase(record.phase)) continue
      if (authority !== record.source.authority) continue
      if (
        this._samePath(cwd, record.source.worktree) ||
        this._samePath(cwd, record.target.mainWorktree) ||
        this._uriIdentity.relativePathUnder(record.source.worktree, cwd) !== null ||
        this._uriIdentity.relativePathUnder(cwd, record.source.worktree) !== null
      ) {
        return record
      }
    }
    return undefined
  }

  private _samePath(a: string, b: string): boolean {
    return this._uriIdentity.arePathsEqual(a, b)
  }

  private _activeRecordForRepo(repositoryKey: string): SessionDeliveryRecord | undefined {
    for (const record of this._records.values()) {
      if (record.repositoryKey !== repositoryKey) continue
      if (isActiveDeliveryPhase(record.phase)) return record
    }
    return undefined
  }

  private async _resolveSourceSession(
    record: SessionDeliveryRecord,
  ): Promise<IAcpSession | undefined> {
    const localId = record.source.sessionLocalId
    if (localId !== undefined) {
      const live = this._sessions.getById(localId)
      if (live !== undefined) return live
    }
    const durableId = record.source.sessionDurableId
    if (durableId === undefined) return undefined
    const live = this._sessions.getById(durableId)
    if (live !== undefined) return live
    try {
      return await this._sessions.resumeSession(durableId, { activate: false })
    } catch {
      return undefined
    }
  }

  private _summary(record: SessionDeliveryRecord): SessionDeliverySummary {
    return {
      deliveryId: record.id,
      phase: record.phase,
      commitCount: record.commits.length,
      dirtySource: record.sourceDirty,
      mainBranch: record.target.mainBranch,
      updatedAt: record.updatedAt,
      ...(record.error !== undefined ? { error: record.error } : {}),
      canConfirmPush:
        record.tempWorktree !== undefined &&
        record.tempHead !== undefined &&
        (record.phase === 'awaiting_push' || record.phase === 'failed'),
      canRetry: record.phase === 'failed' || record.phase === 'partial',
      canUndo:
        record.undo === undefined &&
        (record.phase === 'awaiting_push' ||
          record.phase === 'synced' ||
          record.phase === 'partial' ||
          (record.phase === 'failed' &&
            (record.pushedSha !== undefined ||
              record.tempWorktree !== undefined ||
              record.mainHeadBefore !== undefined))),
      sync: syncSummary(record.syncResults),
    }
  }

  private _put(record: SessionDeliveryRecord): void {
    this._records.set(record.id, record)
    let map = this._repoRecords.get(record.repositoryKey)
    if (map === undefined) {
      map = new Map()
      this._repoRecords.set(record.repositoryKey, map)
    }
    map.set(record.id, record)
    this._emit(record)
    this._schedulePersist(record.repositoryKey)
  }

  private _update(deliveryId: string, patch: RecordPatch): SessionDeliveryRecord | undefined {
    const previous = this._records.get(deliveryId)
    if (previous === undefined) return undefined
    const next = { ...previous, ...patch, updatedAt: Date.now() } as SessionDeliveryRecord
    this._records.set(deliveryId, next)
    const map = this._repoRecords.get(next.repositoryKey)
    map?.set(next.id, next)
    this._emit(next)
    this._schedulePersist(next.repositoryKey)
    return next
  }

  private _emit(record: SessionDeliveryRecord): void {
    if (this._disposed) return
    this._onDidChange.fire({
      deliveryId: record.id,
      ...(record.source.sessionLocalId !== undefined
        ? { sessionLocalId: record.source.sessionLocalId }
        : {}),
      ...(record.source.sessionDurableId !== undefined
        ? { sessionDurableId: record.source.sessionDurableId }
        : {}),
      record,
    })
  }

  private _schedulePersist(repositoryKey: string): void {
    this._writeChain = this._writeChain
      .then(async () => {
        const map = this._repoRecords.get(repositoryKey)
        if (map === undefined) return
        const records = [...map.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_DELIVERIES_PER_REPOSITORY)
        const kept = new Set(records.map((record) => record.id))
        for (const id of [...map.keys()]) {
          if (!kept.has(id)) map.delete(id)
        }
        const active = records.find((record) => isActiveDeliveryPhase(record.phase))
        await this._deliveryStore.rememberRepository(repositoryKey)
        await this._deliveryStore.writeRepository(repositoryKey, {
          version: SESSION_DELIVERY_SCHEMA_VERSION,
          ...(active !== undefined ? { activeId: active.id } : {}),
          records,
        })
      })
      .catch((err: unknown) => {
        this._logger.warn(`failed to persist deliveries for ${repositoryKey}`, err)
      })
  }
}

registerSingleton(ISessionDeliveryService, SessionDeliveryService, InstantiationType.Delayed)
