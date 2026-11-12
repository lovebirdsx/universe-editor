/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reverse mobile channel, renderer side. Projects this window's ACP sessions into
 *  the window-independent bridge DTOs and streams coalesced delta events to the
 *  main gateway. Everything is lazy: until `startStreaming()` runs (the first
 *  phone subscribed to the inbox) this service sets up no watchers and performs
 *  no serialization, so a PC with no phone pays nothing.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  CancellationTokenSource,
  Disposable,
  Emitter,
  ICommandService,
  IEditorGroupsService,
  IFileSearchService,
  IFileService,
  ILoggerService,
  IUriIdentityService,
  IWorkspaceService,
  REMOTE_SCHEME,
  URI,
  absolutePathToWorkspaceUri,
  type IDisposable,
  type ILogger,
  type IReader,
  type CancellationToken,
} from '@universe-editor/platform'
import {
  clampText,
  DEFAULT_COMMIT_PROMPT_REFS,
  isPreviewableImageMimeType,
  MAX_HISTORY_PROMPT_LENGTH,
  MAX_ID_LENGTH,
  MAX_MCP_SERVERS,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_MESSAGE_IMAGE_INDEX,
  MAX_SIDE_TASK_QUOTE_LENGTH,
  MAX_SUBAGENT_MODEL_CANDIDATES,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORKSPACE_IMAGE_BYTES,
  MAX_WORKSPACE_NAME_LENGTH,
  parseWorkspaceRelativePath,
  type MobileAgentCandidate,
  type MobileElicitationAction,
  type MobileElicitationContentValue,
  type MobilePromptRef,
  type MobilePromptRefSuggestion,
  type MobilePromptRefTrigger,
  type MobileRewindPreview,
  type MobileRewindResult,
  type MobileSessionSettings,
  type MobileSideTaskSummary,
  type MobileWorkspaceCandidate,
  type MobileToolCallDetail,
  type ResolvePromptRefRequest,
  type ResolvePromptRefResult,
} from '@universe-editor/mobile-protocol'
import {
  MEDIA_TRUNCATED_META_KEY,
  truncateDiffSideText,
  truncateToolTextBlock,
} from '@universe-editor/acp-view-model'
import { isResumableHistoryEntry } from '../../../shared/mobileGateway/sessionHistoryFilter.js'
import { isPathWithinWorkspace } from '../../../shared/mobileGateway/workspacePathScope.js'
import {
  describeFsError,
  isUnavailablePathError,
} from '../../../shared/mobileGateway/workspaceFsErrors.js'
import type {
  MobileBridgeAttentionEvent,
  MobileBridgeCommandError,
  MobileBridgeDraft,
  MobileBridgeEvent,
  MobileBridgeNewSessionResult,
  MobileBridgePromptAttachment,
  MobileBridgeResult,
  MobileBridgeSessionDelta,
  MobileBridgeSessionEvent,
  MobileBridgeSessionHistoryEntry,
  MobileBridgeSessionSnapshot,
  MobileBridgeSessionSummary,
  MobileBridgeImage,
  MobileBridgeDeliveryContext,
  IMobileBridgeService,
} from '../../../shared/ipc/mobileGatewayService.js'
import {
  AcpPromptDraftCache,
  type AcpPromptDraft,
  type AcpPromptDraftChange,
} from '../acp/session/acpPromptDraftCache.js'
import { mergeBridgeDraft, toBridgeDraft } from './mobileDraftSync.js'
import { MobilePromptRefSearch } from './promptRefSearch.js'
import { MobilePromptRefResolver } from './promptRefResolve.js'
import { toPlacedMobileRefs } from './mobilePromptRefs.js'
import { resolveSessionScopeRoot } from '../acp/sessionScope.js'
import type { PlacedRef } from '../acp/promptRef.js'
import { IExcludeService } from '../exclude/ExcludeService.js'
import { IChatContextService } from '../extensions/ChatContextService.js'
import { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import { IDocsService } from '../../../shared/ipc/docsService.js'
import { AcpForeignWorktreeError, IAcpSessionService } from '../acp/session/acpSessionService.js'
import { IScmService } from '../extensions/ScmService.js'
import {
  collectSideTaskDescendants,
  directSideTaskChildren,
  IAcpSessionHistoryService,
  isForeignWorkspaceSession,
  type AcpSessionHistoryEntry,
} from '../acp/session/acpSessionHistory.js'
import { isResidentLive, isSessionWorking } from '../acp/session/acpSessionStatus.js'
import {
  createAgentAttentionSignal,
  type AgentAttentionSignal,
} from '../acp/session/agentAttentionSignal.js'
import type {
  AcpMessage,
  AcpPendingPermission,
  AcpPendingElicitation,
  IAcpSession,
} from '../acp/session/acpSession.js'
import { IAcpAgentRegistry } from '../acp/acpAgentRegistry.js'
import { mimeTypeForFileName, type PromptImage } from '../acp/promptImage.js'
import type { PromptFileAttachment } from '../acp/promptAttachment.js'
import { IUserSettingsSyncService } from '../configuration/UserSettingsSync.js'
import { selectOptionHasValue } from '../acp/configOptionLabel.js'
import { mergeModelCandidates, sessionModelCandidates } from '../acp/acpModelCandidates.js'
import { filterPoolForSession, resolveMcpServerSelection } from '../acp/acpMcpServers.js'
import { IClaudeConfigService } from '../../../shared/ipc/claudeConfigService.js'
import { deleteSessionPlan, planSessionRemoval } from '../acp/session/sessionRemoval.js'
import { deleteSideTasks } from '../acp/session/sideTaskRemoval.js'
import { ISessionDeliveryService } from '../delivery/sessionDeliveryService.js'
import {
  ISessionBranchPushService,
  type SessionBranchPushPreview,
} from '../delivery/sessionBranchPushService.js'
import {
  worktreeName,
  type SessionDeliveryChange,
  type SessionDeliveryDetail,
  type SessionDeliveryError,
  type SessionDeliveryPreview,
  type SessionDeliverySummary,
} from '../delivery/sessionDeliveryTypes.js'
import type {
  MobilePermissionSettleReason,
  MobilePermissionSettleSource,
  MobileDeliveryDetail,
  MobileDeliveryError,
  MobileDeliveryExpectation,
  MobileDeliveryPreview,
  MobileDeliveryStartResult,
  MobileDeliverySummary,
  MobilePushBranchExpectation,
  MobilePushBranchPreview,
  MobilePushBranchResult,
} from '@universe-editor/mobile-protocol'
import {
  diffAvailableCommands,
  diffConfigOptions,
  diffElicitation,
  diffPermission,
  diffPlan,
  diffTimeline,
  summaryChanged,
  toBridgeSnapshot,
  type PermissionClearMetadata,
  type SessionProjectionOptions,
} from './mobileBridgeProjection.js'
import {
  decodeBase64Bytes,
  imagePathToUri,
  isPathUnderAnyRoot,
  resolveImageRoots,
  resolveMarkdownImageCandidates,
  type MobileImagePathContext,
  type ResolvedImagePath,
} from './mobileImagePath.js'

/** Coalescing window for ordinary session updates. */
export const MOBILE_BRIDGE_THROTTLE_MS = 50
/** Slower window while one message grows by more than {@link MOBILE_BRIDGE_LARGE_DELTA_CHARS}. */
export const MOBILE_BRIDGE_LARGE_THROTTLE_MS = 100
export const MOBILE_BRIDGE_LARGE_DELTA_CHARS = 64 * 1024
/** Draft changes are less urgent than timeline deltas; coalesce keystrokes. */
export const MOBILE_DRAFT_THROTTLE_MS = 250
/** A lost hub ack must not keep a remote draft queued forever. */
export const MOBILE_DRAFT_ACK_TIMEOUT_MS = 2000
/** Backstop for worktree changes made outside a session turn (manual PC edits). */
export const MOBILE_PENDING_WORK_SWEEP_MS = 30_000

const SUBAGENT_MODEL_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL'
const SUBAGENT_MODEL_FORCE_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'

interface SessionStream {
  readonly localId: string
  readonly session: IAcpSession
  watcher: IDisposable | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  timerDelay: number
  disposed: boolean
  pending: MobileBridgeSessionSnapshot | undefined
  publishedTimeline: MobileBridgeSessionSnapshot['timeline']
  publishedPlan: MobileBridgeSessionSnapshot['plan']
  publishedConfigOptions: MobileBridgeSessionSnapshot['configOptions']
  publishedCommands: MobileBridgeSessionSnapshot['availableCommands']
  publishedPermission: MobileBridgeSessionSnapshot['pendingPermission']
  publishedElicitation: MobileBridgeSessionSnapshot['pendingElicitation']
  publishedSummary: MobileBridgeSessionSummary | undefined
  publishedMessageChars: number
  /** Most recent settle of a permission request, attached to `permission_cleared`. */
  lastPermissionSettle: PermissionClearMetadata | undefined
  settleWatcher: IDisposable | undefined
}

/**
 * Per-session ordering bookkeeping for the shared draft. Local publishes and
 * phone drafts are ordered by the hub, but this renderer only learns the order
 * from the revisions the hub echoes back; a remote draft is held as `deferred`
 * until no local publish is waiting, then settled by revision.
 */
interface DraftSyncState {
  lastLocalRevision: number
  lastRemoteRevision: number
  awaitingLocalPublish: number
  deferred: { draft: MobileBridgeDraft; revision: number | undefined } | undefined
  ackTimer: ReturnType<typeof setTimeout> | undefined
}

export class MobileBridgeService extends Disposable implements IMobileBridgeService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = new Emitter<MobileBridgeEvent>()
  readonly onDidChange = this._onDidChange.event

  private readonly _logger: ILogger
  private _streaming = false
  private _attention: AgentAttentionSignal | undefined
  private _rootWatcher: IDisposable | undefined
  private _syncScheduled = false
  private _syncHandle: ReturnType<typeof setTimeout> | undefined
  private readonly _streams = new Map<string, SessionStream>()
  private _draftSubscription: IDisposable | undefined
  private readonly _draftTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly _publishedDrafts = new Map<string, string>()
  /** Attachment id set last published, so a paste/drop skips the typing debounce. */
  private readonly _publishedDraftAttachments = new Map<string, string>()
  private readonly _draftSync = new Map<string, DraftSyncState>()
  private readonly _agentNames = new Map<string, string | undefined>()
  private _attentionSubscription: IDisposable | undefined
  private _pendingWorkSweep: ReturnType<typeof setInterval> | undefined
  private readonly _promptRefSearch: MobilePromptRefSearch
  private readonly _promptRefResolver: MobilePromptRefResolver
  /** Newest completion query per session; a keystroke supersedes the previous walk. */
  private readonly _promptRefSearches = new Map<string, CancellationTokenSource>()
  private _disposed = false

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IAcpAgentRegistry private readonly _agents: IAcpAgentRegistry,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IEditorGroupsService private readonly _editorGroups: IEditorGroupsService,
    @IUserSettingsSyncService private readonly _userSettings: IUserSettingsSyncService,
    @IScmService private readonly _scm: IScmService,
    @IFileService private readonly _files: IFileService,
    @ISessionDeliveryService private readonly _delivery: ISessionDeliveryService,
    @ISessionBranchPushService private readonly _branchPush: ISessionBranchPushService,
    @IFileSearchService fileSearch: IFileSearchService,
    @IExcludeService exclude: IExcludeService,
    @ILanguageFeaturesService langFeatures: ILanguageFeaturesService,
    @IDocsService private readonly _docs: IDocsService,
    @ICommandService private readonly _commands: ICommandService,
    @IChatContextService private readonly _chatContext: IChatContextService,
    @IClaudeConfigService private readonly _claude: IClaudeConfigService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'mobileBridge', name: 'Mobile Bridge' })
    this._promptRefSearch = new MobilePromptRefSearch({
      fileSearch,
      exclude,
      workspace: this._workspace,
      editorGroups: this._editorGroups,
      scm: this._scm,
      uriIdentity: this._uriIdentity,
      langFeatures,
      docs: this._docs,
      chatContext: this._chatContext,
    })
    this._promptRefResolver = new MobilePromptRefResolver({
      commands: this._commands,
      scm: this._scm,
      workspace: this._workspace,
      chatContext: this._chatContext,
    })
    this._register(this._delivery.onDidChange((change) => this._onDeliveryChanged(change)))
  }

  ping(): Promise<'pong'> {
    return Promise.resolve('pong')
  }

  /**
   * Remote windows run their git extension in the remote host; its SCM count
   * (which includes untracked files) is the freshest signal available here.
   */
  getWorkspaceGitDirty(): Promise<boolean | undefined> {
    let sawGitCount = false
    for (const sourceControl of this._scm.sourceControls.get()) {
      if (sourceControl.id !== 'git') continue
      const count = sourceControl.count.get()
      if (count === undefined) continue
      sawGitCount = true
      if (count > 0) return Promise.resolve(true)
    }
    return Promise.resolve(sawGitCount ? false : undefined)
  }

  async listSessions(): Promise<readonly MobileBridgeSessionSummary[]> {
    await this._ensureHistory()
    await this._ensureDelivery()
    const summaries: MobileBridgeSessionSummary[] = []
    for (const session of this._sessions.sessions.get()) {
      if (!isResidentLive(session)) continue
      summaries.push(this._summaryFor(session))
    }
    return summaries
  }

  async listSessionHistory(
    _token?: CancellationToken,
  ): Promise<readonly MobileBridgeSessionHistoryEntry[]> {
    await this._ensureHistory()
    const rows: MobileBridgeSessionHistoryEntry[] = []
    for (const entry of this._history.list()) {
      if (!this._isResumableHistoryEntry(entry)) continue
      const agentName = this._agentNameFor(entry.agentId)
      const firstPrompt = entry.firstPrompt?.trim()
      rows.push({
        durableId: clampText(entry.id, MAX_ID_LENGTH),
        agentId: clampText(entry.agentId, MAX_ID_LENGTH),
        ...(agentName !== undefined ? { agentName: clampText(agentName, MAX_TITLE_LENGTH) } : {}),
        title: clampText(entry.title.length > 0 ? entry.title : entry.id, MAX_TITLE_LENGTH),
        ...(firstPrompt !== undefined && firstPrompt.length > 0
          ? { firstPrompt: clampText(firstPrompt, MAX_HISTORY_PROMPT_LENGTH) }
          : {}),
        ...(entry.cwd !== undefined
          ? { cwd: clampText(entry.cwd, MAX_WORKSPACE_NAME_LENGTH) }
          : {}),
        ...(entry.authority !== undefined
          ? { authority: clampText(entry.authority, MAX_WORKSPACE_NAME_LENGTH) }
          : {}),
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        ...(entry.pinned === true ? { pinned: true } : {}),
      })
    }
    rows.sort(
      (a, b) =>
        Number(b.pinned === true) - Number(a.pinned === true) || b.lastUsedAt - a.lastUsedAt,
    )
    return rows
  }

  async hasSessionHistory(durableId: string, _token?: CancellationToken): Promise<boolean> {
    await this._ensureHistory()
    const entry = this._history.get(durableId)
    return entry !== undefined && this._isResumableHistoryEntry(entry)
  }

  async openSession(
    durableId: string,
    _token?: CancellationToken,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> {
    await this._ensureHistory()
    const entry = this._history.get(durableId)
    if (entry === undefined) return fail('session_not_found', 'unknown session history')
    if (
      isForeignWorkspaceSession(
        entry,
        this._currentCwd(),
        this._currentAuthority(),
        this._uriIdentity,
      )
    ) {
      return fail('forbidden_operation', 'session belongs to another worktree')
    }
    if (!this._isResumableHistoryEntry(entry)) {
      return fail('session_not_found', 'session is not resumable from mobile')
    }
    try {
      // Never activates: opening from the phone must not steal the PC focus.
      const session = await this._sessions.resumeSession(durableId, { activate: false })
      return ok(toNewSessionResult(session))
    } catch (err) {
      return this._commandFailure(err, 'openSession')
    }
  }

  async getSnapshot(localId: string): Promise<MobileBridgeSessionSnapshot | undefined> {
    await this._ensureHistory()
    await this._ensureDelivery()
    const session = this._sessions.getById(localId)
    if (session === undefined || !isResidentLive(session)) return undefined
    // Emit any coalesced delta first so the caller cannot receive an event that
    // precedes this snapshot but describes state the snapshot already carries.
    const stream = this._streams.get(session.id)
    if (stream !== undefined) this._flush(stream)
    const snapshot = toBridgeSnapshot(session, this._projectionOptions(session))
    const withDelivery = {
      ...snapshot,
      summary: this._withDelivery(session, snapshot.summary),
    }
    const draft = this._draftFor(session)
    return draft === undefined ? withDelivery : { ...withDelivery, draft }
  }

  async startStreaming(): Promise<void> {
    if (this._disposed || this._streaming) return
    this._streaming = true
    void this._ensureHistory()
    this._logger.debug('mobile bridge streaming started')
    this._rootWatcher = this._register(
      autorun((r) => {
        void this._sessions.sessions.read(r)
        this._scheduleSync()
      }),
    )
    this._syncNow()
    this._draftSubscription = AcpPromptDraftCache.onDidChange((event) =>
      this._onDraftChanged(event),
    )
    this._pendingWorkSweep = setInterval(
      () => this._sweepPendingWork(),
      MOBILE_PENDING_WORK_SWEEP_MS,
    )
  }

  async stopStreaming(): Promise<void> {
    if (!this._streaming) return
    this._streaming = false
    this._logger.debug('mobile bridge streaming stopped')
    this._rootWatcher?.dispose()
    this._rootWatcher = undefined
    this._draftSubscription?.dispose()
    this._draftSubscription = undefined
    if (this._pendingWorkSweep !== undefined) {
      clearInterval(this._pendingWorkSweep)
      this._pendingWorkSweep = undefined
    }
    for (const timer of this._draftTimers.values()) clearTimeout(timer)
    this._draftTimers.clear()
    this._publishedDrafts.clear()
    this._publishedDraftAttachments.clear()
    for (const sessionId of [...this._draftSync.keys()]) this._resetDraftSync(sessionId)
    if (this._syncHandle !== undefined) {
      clearTimeout(this._syncHandle)
      this._syncHandle = undefined
    }
    this._syncScheduled = false
    for (const stream of this._streams.values()) this._disposeStream(stream)
    this._streams.clear()
  }

  async startAttention(): Promise<void> {
    if (this._disposed || this._attention !== undefined) return
    const signal = createAgentAttentionSignal(this._sessions.sessions)
    this._attention = signal
    this._logger.debug('mobile bridge attention started')
    this._attentionSubscription = this._register(
      signal.onDidAttention((event) => {
        this._emit(this._attentionEventFor(event.session, event.kind))
      }),
    )
  }

  async stopAttention(): Promise<void> {
    if (this._attention === undefined) return
    this._logger.debug('mobile bridge attention stopped')
    this._attentionSubscription?.dispose()
    this._attentionSubscription = undefined
    this._attention.dispose()
    this._attention = undefined
  }

  async getToolCallDetail(
    localId: string,
    toolCallId: string,
  ): Promise<MobileToolCallDetail | undefined> {
    const session = this._sessions.getById(localId)
    if (session === undefined) return undefined
    const call = session.toolCalls.get().find((candidate) => candidate.id === toolCallId)
    if (call === undefined) return undefined
    return {
      id: call.id,
      title: call.title,
      kind: call.kind,
      status: call.status,
      text: truncateToolTextBlock(call.text),
      diffs: call.diffs.map((diff) => ({
        path: diff.path,
        oldText: truncateDiffSideText(diff.oldText),
        newText: truncateDiffSideText(diff.newText),
      })),
      ...(call.locations !== undefined && call.locations.length > 0
        ? { locations: call.locations.slice(0, 256) }
        : {}),
      ...(call.memoryTrimmed ? { memoryTrimmed: true } : {}),
    }
  }

  async getMessageImage(
    localId: string,
    messageId: string,
    index: number,
  ): Promise<MobileBridgeImage | undefined> {
    if (!Number.isInteger(index) || index < 0 || index > MAX_MESSAGE_IMAGE_INDEX) return undefined
    const session = this._sessions.getById(localId)
    if (session === undefined) return undefined
    const message = session.messages.get().find((candidate) => candidate.id === messageId)
    if (message === undefined) return undefined
    let ordinal = 0
    for (const block of message.blocks) {
      if (block.type !== 'image') continue
      if (ordinal++ !== index) continue
      // The phone already owns attachments it uploaded; they are served by the
      // attachment store, and a truncated block has no bytes left to serve.
      if (block._meta?.['mobileAttachment'] !== undefined) return undefined
      if (block._meta?.[MEDIA_TRUNCATED_META_KEY] === true) return undefined
      const mimeType = block.mimeType.toLowerCase()
      if (!isPreviewableImageMimeType(mimeType)) return undefined
      const bytes = decodeBase64Bytes(block.data, MAX_MESSAGE_IMAGE_BYTES)
      return bytes === undefined ? undefined : { mimeType, bytes }
    }
    return undefined
  }

  async getWorkspaceImage(localId: string, src: string): Promise<MobileBridgeImage | undefined> {
    const session = this._sessions.getById(localId)
    if (session === undefined) return undefined
    const context: MobileImagePathContext = {
      cwd: session.cwd,
      authority: session.authority,
      workspaceFolder: this._workspace.current?.folder,
      identity: this._uriIdentity,
    }
    const candidates = resolveMarkdownImageCandidates(src, context)
    if (candidates.length === 0) return undefined
    const roots = resolveImageRoots(context)
    for (const candidate of candidates) {
      const image = await this._readWorkspaceImage(candidate, roots, context)
      if (image !== undefined) return image
    }
    return undefined
  }

  async applyDraft(localId: string, draft: MobileBridgeDraft): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const state = this._draftSyncState(session.id)
    // Never replace a buffer the user is still editing (or whose publish is in
    // flight): the local publish will receive a newer hub revision.
    if (this._draftTimers.has(session.id) || state.awaitingLocalPublish > 0) {
      state.deferred = { draft, revision: undefined }
      return ok(undefined)
    }
    this._applyRemoteDraftNow(session, draft)
    return ok(undefined)
  }

  async noteDraftRevision(localId: string, revision: number): Promise<void> {
    const session = this._liveSession(localId)
    if (session === undefined) return
    const state = this._draftSyncState(session.id)
    if (state.deferred !== undefined) {
      state.deferred = { draft: state.deferred.draft, revision }
      this._settleDeferredDraft(session, state)
      return
    }
    state.lastRemoteRevision = Math.max(state.lastRemoteRevision, revision)
  }

  async ackDraftRevision(localId: string, revision: number): Promise<void> {
    const session = this._liveSession(localId)
    if (session === undefined) return
    const state = this._draftSyncState(session.id)
    state.lastLocalRevision = Math.max(state.lastLocalRevision, revision)
    if (state.awaitingLocalPublish > 0) state.awaitingLocalPublish -= 1
    this._settleDeferredDraft(session, state)
  }

  private _draftSyncState(sessionId: string): DraftSyncState {
    let state = this._draftSync.get(sessionId)
    if (state === undefined) {
      state = {
        lastLocalRevision: 0,
        lastRemoteRevision: 0,
        awaitingLocalPublish: 0,
        deferred: undefined,
        ackTimer: undefined,
      }
      this._draftSync.set(sessionId, state)
    }
    return state
  }

  private _resetDraftSync(sessionId: string): void {
    const state = this._draftSync.get(sessionId)
    if (state === undefined) return
    if (state.ackTimer !== undefined) clearTimeout(state.ackTimer)
    this._draftSync.delete(sessionId)
  }

  private _settleDeferredDraft(session: IAcpSession, state: DraftSyncState): void {
    const deferred = state.deferred
    if (deferred === undefined) return
    if (state.awaitingLocalPublish > 0 || this._draftTimers.has(session.id)) return
    const revision = deferred.revision
    if (
      revision !== undefined &&
      revision <= Math.max(state.lastLocalRevision, state.lastRemoteRevision)
    ) {
      // The hub already processed a newer local (or applied remote) draft.
      state.deferred = undefined
      return
    }
    state.deferred = undefined
    if (revision !== undefined)
      state.lastRemoteRevision = Math.max(state.lastRemoteRevision, revision)
    this._applyRemoteDraftNow(session, deferred.draft)
  }

  private _applyRemoteDraftNow(session: IAcpSession, draft: MobileBridgeDraft): void {
    const next = mergeBridgeDraft(AcpPromptDraftCache.load(session.id), draft)
    if (next === undefined) {
      AcpPromptDraftCache.clear(session.id, { source: 'remote' })
    } else {
      AcpPromptDraftCache.save(session.id, next, { source: 'remote' })
    }
  }

  private _armDraftAckTimeout(sessionId: string, state: DraftSyncState): void {
    if (state.ackTimer !== undefined) clearTimeout(state.ackTimer)
    state.ackTimer = setTimeout(() => {
      state.ackTimer = undefined
      // A lost ack must not keep a remote draft queued forever.
      state.awaitingLocalPublish = 0
      const session = this._liveSession(sessionId)
      if (session !== undefined) this._settleDeferredDraft(session, state)
    }, MOBILE_DRAFT_ACK_TIMEOUT_MS)
  }

  async getDraftImage(
    localId: string,
    imageId: string,
    _token?: CancellationToken,
  ): Promise<MobileBridgeImage | undefined> {
    const session = this._liveSession(localId)
    if (session === undefined) return undefined
    const image = AcpPromptDraftCache.load(session.id)?.images?.find(
      (candidate) => candidate.id === imageId,
    )
    if (image === undefined) return undefined
    try {
      const binary = atob(image.dataBase64)
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return { mimeType: image.mimeType, bytes }
    } catch {
      return undefined
    }
  }

  async attachDraftAttachments(
    localId: string,
    attachments: readonly MobileBridgePromptAttachment[],
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (attachments.length === 0) return ok(undefined)
    const current: AcpPromptDraft = AcpPromptDraftCache.load(session.id) ?? { text: '' }
    const images = [...(current.images ?? [])]
    const files = [...(current.files ?? [])]
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        const image: PromptImage = {
          id: attachment.id,
          attachmentId: attachment.id,
          mimeType: attachment.mimeType,
          dataBase64: attachment.dataBase64,
          byteSize: attachment.byteSize,
          name: attachment.name,
        }
        const index = images.findIndex((candidate) => candidate.id === attachment.id)
        if (index === -1) images.push(image)
        else images[index] = image
      } else {
        const file: PromptFileAttachment = {
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          byteSize: attachment.byteSize,
          uri: attachment.uri,
        }
        const index = files.findIndex((candidate) => candidate.id === attachment.id)
        if (index === -1) files.push(file)
        else files[index] = file
      }
    }
    AcpPromptDraftCache.save(
      session.id,
      {
        ...current,
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      },
      { source: 'remote' },
    )
    return ok(undefined)
  }

  async resolveDraftAttachments(
    localId: string,
    imageIds: readonly string[],
    fileIds: readonly string[] = [],
  ): Promise<MobileBridgeResult<readonly MobileBridgePromptAttachment[]>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const draft = AcpPromptDraftCache.load(session.id)
    const images = draft?.images ?? []
    const resolved: MobileBridgePromptAttachment[] = []
    for (const id of imageIds) {
      const image = images.find((candidate) => candidate.id === id)
      if (image === undefined) continue
      resolved.push({
        kind: 'image',
        id: image.id,
        name: image.name ?? 'image',
        mimeType: image.mimeType,
        byteSize: image.byteSize,
        dataBase64: image.dataBase64,
      })
    }
    for (const id of fileIds) {
      const file = (draft?.files ?? []).find((candidate) => candidate.id === id)
      if (file === undefined) continue
      resolved.push({
        kind: 'file',
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        uri: file.uri,
      })
    }
    if (resolved.length !== imageIds.length + fileIds.length) {
      return fail('attachment_not_found', 'draft attachment is no longer available')
    }
    return ok(resolved)
  }

  async clearDraft(localId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    // The prompt was accepted: a queued local publish must not resurrect the
    // submitted text, and any deferred phone draft belongs to the old epoch.
    this._cancelDraftTimer(session.id)
    this._resetDraftSync(session.id)
    this._publishedDrafts.set(session.id, 'null')
    this._publishedDraftAttachments.delete(session.id)
    AcpPromptDraftCache.clear(session.id, { source: 'remote' })
    return ok(undefined)
  }

  private _draftFor(session: IAcpSession): MobileBridgeDraft | undefined {
    const draft = AcpPromptDraftCache.load(session.id)
    return draft === undefined ? undefined : toBridgeDraft(draft)
  }

  /** Missing docs roots degrade to none — a ref that needs them is then rejected. */
  private async _docsRoots(): Promise<readonly string[]> {
    const roots: string[] = []
    for (const category of ['user', 'extensionDev'] as const) {
      try {
        const root = await this._docs.getDocsRoot(category)
        if (root.length > 0) roots.push(root)
      } catch {
        continue
      }
    }
    return roots
  }

  /**
   * Workspace URIs of the open Git repos. A commit ref points at the repo root,
   * which may be above a narrowed session's cwd, so it cannot use `mentionRoot`.
   */
  private _gitCommitRoots(): readonly URI[] {
    const folder = this._workspace.current?.folder
    const roots: URI[] = []
    for (const control of this._scm.sourceControls.get()) {
      if (control.id !== 'git' || control.rootUri === undefined) continue
      roots.push(absolutePathToWorkspaceUri(control.rootUri, folder))
    }
    return roots
  }

  private _onDraftChanged(event: AcpPromptDraftChange): void {
    if (!this._streaming) return
    const session = this._liveSession(event.sessionId)
    if (session === undefined) return
    // A remote write (an applied phone draft or a materialized attachment) must
    // not cancel a queued local publish: this window's unsent keystrokes would
    // be lost and the phone would keep the older text.
    if (event.source !== 'local') return
    const draft = event.draft === undefined ? undefined : toBridgeDraft(event.draft)
    const key = JSON.stringify(draft ?? null)
    if (this._publishedDrafts.get(session.id) === key) return
    const attachments = attachmentKey(draft)
    const publishedAttachments = this._publishedDraftAttachments.get(session.id)
    const attachmentsChanged =
      publishedAttachments !== undefined && publishedAttachments !== attachments
    this._cancelDraftTimer(session.id)
    // A paste/drop must not wait behind typing: the phone's next keystroke
    // would otherwise publish the older attachment set and delete the new one.
    if (draft === undefined || attachmentsChanged) {
      this._publishDraft(session, draft, key, attachments)
      return
    }
    this._draftTimers.set(
      session.id,
      setTimeout(() => {
        this._draftTimers.delete(session.id)
        // Only a phone attachment materialization can touch the cache while
        // this timer is queued (it preserves the local text), so publish the
        // merged content instead of dropping the local edit.
        const latest = this._draftFor(session)
        this._publishDraft(session, latest, JSON.stringify(latest ?? null), attachmentKey(latest))
      }, MOBILE_DRAFT_THROTTLE_MS),
    )
  }

  private _publishDraft(
    session: IAcpSession,
    draft: MobileBridgeDraft | undefined,
    key: string,
    attachments: string,
  ): void {
    this._publishedDrafts.set(session.id, key)
    this._publishedDraftAttachments.set(session.id, attachments)
    const state = this._draftSyncState(session.id)
    state.awaitingLocalPublish += 1
    this._armDraftAckTimeout(session.id, state)
    this._emit({ kind: 'draft', localId: session.id, draft })
  }

  private _cancelDraftTimer(sessionId: string): void {
    const timer = this._draftTimers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this._draftTimers.delete(sessionId)
  }

  private async _readWorkspaceImage(
    candidate: ResolvedImagePath,
    roots: readonly string[],
    context: MobileImagePathContext,
  ): Promise<MobileBridgeImage | undefined> {
    let resource = candidate.uri
    const realpath = this._files.realpath?.bind(this._files)
    if (realpath !== undefined) {
      try {
        resource = await realpath(resource)
      } catch (err) {
        this._logger.debug(`mobile image realpath failed: ${String(err)}`)
        return undefined
      }
      // A symlink may point outside the roots; re-run the allow-list on the
      // real path. The root itself may live behind a symlink, so fall back to
      // comparing against the roots' real paths before rejecting.
      if (!isPathUnderAnyRoot(resource.fsPath, roots, context.identity)) {
        let underRealRoot = false
        for (const root of roots) {
          try {
            const realRoot = await realpath(imagePathToUri(root, context.authority))
            if (isPathUnderAnyRoot(resource.fsPath, [realRoot.fsPath], context.identity)) {
              underRealRoot = true
              break
            }
          } catch {
            continue
          }
        }
        if (!underRealRoot) return undefined
      }
    }
    let size: number
    try {
      const stat = await this._files.stat(resource)
      if (!stat.isFile) return undefined
      size = stat.size
    } catch {
      return undefined
    }
    if (size <= 0 || size > MAX_WORKSPACE_IMAGE_BYTES) return undefined
    const mimeType = mimeTypeForFileName(resource.path) || candidate.mimeType
    if (mimeType === '' || !isPreviewableImageMimeType(mimeType)) return undefined
    try {
      const bytes = await this._files.readFile(resource)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKSPACE_IMAGE_BYTES) return undefined
      return { mimeType, bytes }
    } catch (err) {
      this._logger.debug(`mobile image read failed: ${String(err)}`)
      return undefined
    }
  }

  /**
   * Read-only `@` / `#` completion. A read-only session may still query: the
   * suggestions never mutate the session, and the phone needs the same catalog
   * it would get from an editable one.
   */
  async searchPromptRefs(
    localId: string,
    trigger: MobilePromptRefTrigger,
    query: string,
    limit: number,
  ): Promise<MobileBridgeResult<readonly MobilePromptRefSuggestion[]>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const scope = resolveSessionScopeRoot(
      this._workspace.current?.folder,
      session.cwd,
      this._uriIdentity,
    )
    if (scope === undefined) return ok([])
    const previous = this._promptRefSearches.get(localId)
    previous?.cancel()
    previous?.dispose()
    const cts = new CancellationTokenSource()
    this._promptRefSearches.set(localId, cts)
    try {
      const entries = await this._promptRefSearch.search(scope, trigger, query, limit, cts.token)
      return cts.token.isCancellationRequested ? ok([]) : ok(entries)
    } catch (err) {
      if (cts.token.isCancellationRequested) return ok([])
      this._logger.warn(`mobile prompt ref search failed: ${String(err)}`)
      return fail('internal', 'prompt reference search failed')
    } finally {
      if (this._promptRefSearches.get(localId) === cts) this._promptRefSearches.delete(localId)
      cts.dispose()
    }
  }

  /**
   * Second-step resolution for `#` commit / extension entries. Read-only like
   * `searchPromptRefs`: chatContext may open an extension picker on this PC, but
   * neither path mutates the session.
   */
  async resolvePromptRef(
    localId: string,
    request: ResolvePromptRefRequest,
  ): Promise<MobileBridgeResult<ResolvePromptRefResult>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    try {
      if (request.kind === 'commit') {
        const entries = await this._promptRefResolver.resolveCommit(
          request.limit ?? DEFAULT_COMMIT_PROMPT_REFS,
        )
        return ok({ kind: 'commit', entries })
      }
      if (request.handle === undefined || request.label === undefined) {
        return fail('bad_request', 'chatContext requires a provider handle and label')
      }
      const scope = resolveSessionScopeRoot(
        this._workspace.current?.folder,
        session.cwd,
        this._uriIdentity,
      )
      const entry = await this._promptRefResolver.resolveChatContext(
        request.handle,
        request.query,
        request.label,
        scope === undefined ? undefined : scope.root.fsPath,
      )
      return ok({ kind: 'chatContext', ...(entry !== undefined ? { entry } : {}) })
    } catch (err) {
      this._logger.warn(`mobile prompt ref resolve failed: ${String(err)}`)
      return fail('internal', 'prompt reference resolve failed')
    }
  }

  async sendPrompt(
    localId: string,
    text: string,
    attachments: readonly MobileBridgePromptAttachment[] = [],
    refs: readonly MobilePromptRef[] = [],
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (this._delivery.isDeliveryBusyForSession(session)) {
      return fail(
        'delivery_busy',
        'A delivery is running for this worktree; wait for it to finish before prompting.',
      )
    }
    const images: PromptImage[] = []
    const files: PromptFileAttachment[] = []
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        images.push({
          id: attachment.id,
          attachmentId: attachment.id,
          mimeType: attachment.mimeType,
          dataBase64: attachment.dataBase64,
          byteSize: attachment.byteSize,
          name: attachment.name,
        })
      } else {
        if (session.authority !== undefined) {
          return fail(
            'forbidden_operation',
            'remote sessions cannot read files uploaded to this PC',
          )
        }
        files.push({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          byteSize: attachment.byteSize,
          uri: attachment.uri,
        })
      }
    }
    if (images.length > 0 && session.imageSupported.get() !== true) {
      return fail('not_supported', 'this agent does not accept image attachments')
    }
    let placed: readonly PlacedRef[] | undefined
    if (refs.length > 0) {
      const scope = resolveSessionScopeRoot(
        this._workspace.current?.folder,
        session.cwd,
        this._uriIdentity,
      )
      if (scope === undefined) {
        return fail('bad_request', 'no workspace is open to resolve prompt references')
      }
      const needsDocs = refs.some((ref) => ref.kind === 'docs')
      const needsCommit = refs.some((ref) => ref.kind === 'commit')
      const converted = toPlacedMobileRefs(text, refs, {
        mentionRoot: scope.root,
        uriIdentity: this._uriIdentity,
        docsRoots: needsDocs ? await this._docsRoots() : [],
        commitRoots: needsCommit ? this._gitCommitRoots() : [],
      })
      if (!converted.ok) return fail('bad_request', converted.message)
      placed = converted.value
    }
    // Return once the prompt is accepted by the session (append + queue); the
    // actual agent round-trip is intentionally not awaited.
    const dispatch =
      placed !== undefined && placed.length > 0
        ? session.sendPrompt(text, placed, undefined, images, files)
        : images.length === 0 && files.length === 0
          ? session.sendPrompt(text)
          : session.sendPrompt(text, undefined, undefined, images, files)
    void dispatch.catch((err: unknown) => {
      this._logger.warn(`mobile sendPrompt failed: ${String(err)}`)
    })
    return ok(undefined)
  }

  async cancelTurn(localId: string): Promise<MobileBridgeResult<void>> {
    return this._run(localId, (session) => session.cancelTurn())
  }

  async resolvePermission(
    localId: string,
    requestId: string,
    optionId: string,
    feedback?: string,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const pending = this._pendingPermission(session, requestId)
    if (pending === undefined)
      return fail('stale_request', 'permission request is no longer pending')
    const option = pending.options.find((candidate) => candidate.optionId === optionId)
    if (option === undefined) return fail('bad_request', 'unknown permission option')
    pending.resolveWithSource(optionId, 'mobile', feedback)
    return ok(undefined)
  }

  async cancelPermission(localId: string, requestId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const pending = this._pendingPermission(session, requestId)
    if (pending === undefined)
      return fail('stale_request', 'permission request is no longer pending')
    pending.cancelWithSource('mobile', 'cancelled')
    return ok(undefined)
  }

  async resolveElicitation(
    localId: string,
    requestId: string,
    action: MobileElicitationAction,
    content?: Record<string, MobileElicitationContentValue>,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const pending = this._pendingElicitation(session, requestId)
    if (pending === undefined) return fail('stale_request', 'elicitation is no longer pending')
    pending.resolveWithSource(
      action === 'accept' ? { action: 'accept', ...(content ? { content } : {}) } : { action },
      'mobile',
    )
    return ok(undefined)
  }

  async setConfigOption(
    localId: string,
    configId: string,
    value: string | boolean,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const option = session.configOptions.get().find((candidate) => candidate.id === configId)
    if (option === undefined) return fail('bad_request', 'unknown config option')
    if (option.type === 'boolean' && typeof value !== 'boolean') {
      return fail('bad_request', 'boolean config option needs a boolean value')
    }
    if (option.type === 'select') {
      if (typeof value !== 'string' || !selectOptionHasValue(option, value)) {
        return fail('bad_request', 'unknown config value')
      }
    }
    return this._run(localId, (live) => live.setConfigOption(configId, value))
  }

  async getSessionSettings(localId: string): Promise<MobileBridgeResult<MobileSessionSettings>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')

    const supported = session.agentId === 'claude-code'
    let current: string | null = null
    let candidates: readonly string[] = []
    if (supported) {
      let settings: Awaited<ReturnType<IClaudeConfigService['read']>>
      try {
        // The session's host, not the window's: fork / preview sessions can
        // belong to a different authority than the active workspace.
        settings = await this._claude.read(session.authority)
      } catch (err) {
        this._logger.warn(`mobile getSessionSettings read failed: ${String(err)}`)
        return fail('internal', 'failed to read the agent settings')
      }
      const raw = settings.env?.[SUBAGENT_MODEL_ENV]
      current = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
      candidates = mergeModelCandidates(
        sessionModelCandidates(session.configOptions.get()),
        current === null ? [] : [current],
      ).slice(0, MAX_SUBAGENT_MODEL_CANDIDATES)
    }

    // The desktop picker also refreshes on open so a `.mcp.json` edited on disk
    // is picked up; a failed refresh keeps the service's existing mirror.
    try {
      await this._sessions.refreshMcpServerDefinitions()
    } catch (err) {
      this._logger.warn(`mobile getSessionSettings mcp refresh failed: ${String(err)}`)
    }
    const pool = filterPoolForSession(
      this._sessions.mcpServerDefinitions.get(),
      session.agentId,
    ).slice(0, MAX_MCP_SERVERS)
    const selection = session.mcpServerSelection.get()
    const { enabledNames } = resolveMcpServerSelection(pool, selection)
    const live = session.mcpServers.get().slice(0, MAX_MCP_SERVERS)

    return ok({
      canEdit: !session.readOnly,
      subagentModel: { supported, current, candidates },
      mcp: {
        pool: pool.map((definition) => ({
          name: definition.name,
          transport: definition.transport,
          defaultDisabled: definition.disabled,
        })),
        selection: selection === null ? null : [...selection],
        enabled: enabledNames,
        live: live.map((server) => ({
          name: server.name,
          status: server.status,
          ...(server.transport !== undefined ? { transport: server.transport } : {}),
        })),
      },
    })
  }

  async setSubagentModel(localId: string, model: string | null): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (session.agentId !== 'claude-code') {
      return fail('unsupported_by_agent', 'agent does not support a subagent model')
    }
    const next = model === null ? null : model.trim()
    if (model !== null && next === '') return fail('bad_request', 'invalid model id')

    if (next !== null) {
      let onDisk: string | null = null
      try {
        const settings = await this._claude.read(session.authority)
        const raw = settings.env?.[SUBAGENT_MODEL_ENV]
        onDisk = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
      } catch (err) {
        this._logger.warn(`mobile setSubagentModel read failed: ${String(err)}`)
        return fail('internal', 'failed to read the agent settings')
      }
      const allowed = mergeModelCandidates(
        sessionModelCandidates(session.configOptions.get()),
        onDisk === null ? [] : [onDisk],
      )
      if (!allowed.includes(next)) return fail('bad_request', 'unknown model')
    }

    try {
      await this._claude.patch(
        {
          env: {
            [SUBAGENT_MODEL_ENV]: next,
            [SUBAGENT_MODEL_FORCE_ENV]: next === null ? null : '1',
          },
        },
        session.authority,
      )
    } catch (err) {
      this._logger.warn(`mobile setSubagentModel patch failed: ${String(err)}`)
      return fail('internal', 'failed to write the agent settings')
    }
    return ok(undefined)
  }

  async restartAgentProcess(localId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (session.isReconnecting) return fail('session_busy', 'session is reconnecting')
    // `requestProcessRestart` silently no-ops without a durable id; surface it
    // instead of telling the phone a restart happened when nothing did.
    if (session.sessionIdOnAgent.get() === undefined) {
      return fail('not_supported', 'session is not resumable yet')
    }
    session.requestProcessRestart()
    return ok(undefined)
  }

  async setSessionMcpServers(
    localId: string,
    servers: readonly string[] | null,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')

    let next: readonly string[] | null = null
    if (servers !== null) {
      next = [...new Set(servers)]
      if (next.length > MAX_MCP_SERVERS) return fail('bad_request', 'too many MCP servers')
      const union = this._sessions.mcpServerDefinitions.get()
      const allowed = new Set(
        filterPoolForSession(union, session.agentId).map((definition) => definition.name),
      )
      const unionNames = new Set(union.map((definition) => definition.name))
      for (const name of next) {
        // A name that exists in the union but belongs to another agent is a
        // cross-agent pin; a name absent from the union is a stale pin whose
        // definition was deleted, which the wire filter drops like the desktop.
        if (!allowed.has(name) && unionNames.has(name)) {
          return fail('bad_request', 'MCP server does not belong to this agent')
        }
      }
    }

    // Synchronous: sets the observable and, when the session is idle, converges
    // the connection through the existing MCP drift reload.
    this._sessions.setSessionMcpServers(localId, next)
    return ok(undefined)
  }

  async pauseAutoResolve(localId: string, requestId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const pending = this._pendingPermission(session, requestId)
    if (pending?.autoResolve === undefined) {
      return fail('stale_request', 'auto-execute countdown is no longer running')
    }
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    pending.autoResolve.pause()
    return ok(undefined)
  }

  async resumeAutoResolve(localId: string, requestId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const pending = this._pendingPermission(session, requestId)
    if (pending?.autoResolve === undefined) {
      return fail('stale_request', 'auto-execute countdown is no longer running')
    }
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    pending.autoResolve.resume()
    return ok(undefined)
  }

  async newSession(
    agentId: string,
    workspace: { folder: string; authority?: string; relativePath?: string },
    initialPrompt: string | null,
    token?: CancellationToken,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> {
    // A phone command is a one-shot cold-start action: the new window's
    // hydration is fired-and-forgotten by ConfigInitContribution, so without
    // this wait a custom `acp.agents` entry may still be missing.
    await this._userSettings.whenInitialized
    // The gateway's deadline may expire while hydration is in flight; do not
    // create a session the phone has already been told failed.
    if (token?.isCancellationRequested) return fail('internal', 'command cancelled')
    try {
      this._agents.get(agentId)
    } catch {
      return fail('bad_request', 'unknown agent')
    }
    let folder: URI
    try {
      folder = URI.parse(workspace.folder)
    } catch {
      return fail('bad_request', 'invalid workspace folder')
    }
    if (!folder.scheme) return fail('bad_request', 'invalid workspace folder')
    const authority =
      workspace.authority ??
      (folder.scheme === REMOTE_SCHEME && folder.authority ? folder.authority : undefined)
    const relativePath = parseWorkspaceRelativePath(workspace.relativePath)
    if (relativePath === null) return fail('bad_request', 'invalid workspace-relative path')

    let cwd = folder
    if (relativePath.segments.length > 0) {
      try {
        cwd = URI.joinPath(folder, ...relativePath.segments)
      } catch {
        return fail('bad_request', 'invalid session directory')
      }
      try {
        const stat = await this._files.stat(cwd)
        if (!stat.isDirectory) return fail('bad_request', 'session directory is not a directory')
      } catch (err) {
        if (!isUnavailablePathError(err)) {
          this._logger.warn(`mobile newSession stat failed: ${describeFsError(err)}`)
          return fail('internal', 'failed to inspect session directory')
        }
        return fail('bad_request', 'session directory is unavailable')
      }
      const realpath = this._files.realpath?.bind(this._files)
      if (realpath !== undefined) {
        let realFolder: URI
        let realCwd: URI
        try {
          realFolder = await realpath(folder)
          realCwd = await realpath(cwd)
        } catch (err) {
          if (!isUnavailablePathError(err)) {
            this._logger.warn(`mobile newSession realpath failed: ${describeFsError(err)}`)
            return fail('internal', 'failed to resolve session directory')
          }
          return fail('bad_request', 'session directory cannot be resolved')
        }
        if (!isPathWithinWorkspace(realFolder, realCwd, this._uriIdentity.platform)) {
          return fail('bad_request', 'session directory is outside the workspace')
        }
      }
      if (token?.isCancellationRequested) return fail('internal', 'command cancelled')
    }

    if (this._delivery.isDeliveryBusyForCwd(folder.fsPath, authority)) {
      return fail(
        'delivery_busy',
        'A delivery is running for this repository; wait for it to finish before starting a session.',
      )
    }
    try {
      const session = await this._sessions.createSession(agentId, {
        cwd: cwd.fsPath,
        ...(authority !== undefined ? { authority } : {}),
      })
      if (initialPrompt !== null && initialPrompt.length > 0) {
        void session.sendPrompt(initialPrompt).catch((err: unknown) => {
          this._logger.warn(`mobile newSession initial prompt failed: ${String(err)}`)
        })
      }
      const durableId = session.sessionIdOnAgent.get()
      return ok({
        localId: session.id,
        ...(durableId !== undefined ? { durableId } : {}),
      })
    } catch (err) {
      return fail('internal', `failed to create session: ${String(err)}`)
    }
  }

  async renameSession(localId: string, title: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    session.renameTitle(title)
    return ok(undefined)
  }

  async closeSession(localId: string): Promise<MobileBridgeResult<void>> {
    // Closing the live session fires `onDidCloseSession`; the session-editor
    // lifecycle contribution closes the matching tab, so the PC reflects this
    // exactly as if the user had closed the tab there.
    return this._run(localId, (session) => this._sessions.closeSession(session.id))
  }

  async deleteSession(localId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (this._delivery.isDeliveryBusyForSession(session)) {
      return fail(
        'delivery_busy',
        'finish or undo the active delivery before deleting this session',
      )
    }
    // Same plan → execute pipeline as the PC "Delete Agent Session" command;
    // the phone already confirmed, so only the execution half runs here.
    const plan = planSessionRemoval(this._sessions, this._history, localId)
    await deleteSessionPlan(plan, this._sessions, this._history, this._editorGroups)
    return ok(undefined)
  }

  async deleteHistorySession(durableId: string): Promise<MobileBridgeResult<void>> {
    await this._ensureHistory()
    const entry = this._history.get(durableId)
    if (entry === undefined) return fail('session_not_found', 'unknown session history')
    if (
      isForeignWorkspaceSession(
        entry,
        this._currentCwd(),
        this._currentAuthority(),
        this._uriIdentity,
      )
    ) {
      return fail('forbidden_operation', 'session belongs to another worktree')
    }
    if (!this._isResumableHistoryEntry(entry)) {
      return fail('session_not_found', 'session is not resumable from mobile')
    }
    // The PC may have resumed this row after the phone listed it; keep the same
    // guards as the live delete path before the shared pipeline closes it.
    const live = this._sessions.getById(durableId)
    if (live !== undefined && isResidentLive(live)) {
      if (live.readOnly) return fail('session_read_only', 'session is read-only')
      if (this._delivery.isDeliveryBusyForSession(live)) {
        return fail(
          'delivery_busy',
          'finish or undo the active delivery before deleting this session',
        )
      }
    }
    try {
      const plan = planSessionRemoval(this._sessions, this._history, durableId)
      await deleteSessionPlan(plan, this._sessions, this._history, this._editorGroups)
      return ok(undefined)
    } catch (err) {
      return this._commandFailure(err, 'deleteHistorySession')
    }
  }

  async forkSession(
    localId: string,
    messageId?: string,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> {
    await this._ensureHistory()
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (!session.forkSupported.get()) {
      return fail('unsupported_by_agent', 'agent does not support forking')
    }
    if (isSessionWorking(session)) return fail('session_busy', 'session is running')
    if (messageId !== undefined) {
      const messages = session.messages.get()
      const anchor = findUserAnchor(messages, messageId)
      if (anchor === undefined) return fail('invalid_anchor', 'message is not a user-turn anchor')
      if (anchor.id === firstUserMessage(messages)?.id) {
        return fail('invalid_anchor', 'cannot fork before the first user turn')
      }
    }
    try {
      const forked = await this._sessions.forkSession(session.id, messageId, { activate: false })
      return ok(toNewSessionResult(forked))
    } catch (err) {
      return this._commandFailure(err, 'forkSession')
    }
  }

  async previewRewind(
    localId: string,
    messageId: string,
  ): Promise<MobileBridgeResult<MobileRewindPreview>> {
    await this._ensureHistory()
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (!session.rewindSupported.get()) {
      return fail('unsupported_by_agent', 'agent does not support rewinding')
    }
    if (findUserAnchor(session.messages.get(), messageId) === undefined) {
      return fail('invalid_anchor', 'message is not a user-turn anchor')
    }
    try {
      const result = await this._sessions.rewindSession(session.id, messageId, { dryRun: true })
      if (result === undefined) return fail('internal', 'rewind preview is unavailable')
      return ok({
        canRewind: result.canRewind,
        ...(result.error !== undefined ? { error: clampText(result.error, MAX_TEXT_LENGTH) } : {}),
        filesChanged: result.filesChanged?.length ?? 0,
        ...(result.insertions !== undefined ? { insertions: result.insertions } : {}),
        ...(result.deletions !== undefined ? { deletions: result.deletions } : {}),
      })
    } catch (err) {
      return this._commandFailure(err, 'previewRewind')
    }
  }

  async rewindSession(
    localId: string,
    messageId: string,
    rewindFiles?: boolean,
  ): Promise<MobileBridgeResult<MobileRewindResult>> {
    await this._ensureHistory()
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (!session.rewindSupported.get()) {
      return fail('unsupported_by_agent', 'agent does not support rewinding')
    }
    const anchor = findUserAnchor(session.messages.get(), messageId)
    if (anchor === undefined) return fail('invalid_anchor', 'message is not a user-turn anchor')
    try {
      const result = await this._sessions.rewindSession(
        session.id,
        messageId,
        rewindFiles === false ? { rewindFiles: false } : {},
      )
      if (result === undefined) return fail('internal', 'rewind is unavailable')
      return ok({
        canRewind: result.canRewind,
        ...(result.error !== undefined ? { error: clampText(result.error, MAX_TEXT_LENGTH) } : {}),
        // Returned only for the phone-side composer backfill; it is never
        // written to the PC inbox (the desktop keeps its own draft).
        ...(result.canRewind ? { text: clampText(anchor.text, MAX_TEXT_LENGTH) } : {}),
      })
    } catch (err) {
      return this._commandFailure(err, 'rewindSession')
    }
  }

  async createSideTask(
    localId: string,
    quote?: string,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> {
    await this._ensureHistory()
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (!session.forkSupported.get()) {
      return fail('unsupported_by_agent', 'agent does not support side tasks')
    }
    try {
      const side = await this._sessions.forkSideTask(session.id, prepareSideTaskQuote(quote))
      return ok(toNewSessionResult(side))
    } catch (err) {
      return this._commandFailure(err, 'createSideTask')
    }
  }

  async listSideTasks(
    localId: string,
  ): Promise<MobileBridgeResult<readonly MobileSideTaskSummary[]>> {
    await this._ensureHistory()
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const parentId = session.sessionIdOnAgent.get()
    if (parentId === undefined) return ok([])
    const summaries = directSideTaskChildren(this._history.list(), parentId).map((row) => ({
      id: row.id,
      title: clampText(row.title, MAX_TITLE_LENGTH),
      lastUsedAt: row.lastUsedAt,
      live: isResidentLiveSession(this._sessions.getById(row.id)),
    }))
    return ok(summaries)
  }

  async openSideTask(
    localId: string,
    sideTaskId: string,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> {
    await this._ensureHistory()
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const parentId = session.sessionIdOnAgent.get()
    if (parentId === undefined) return fail('invalid_anchor', 'session has no durable id')
    const entry = this._history.get(sideTaskId)
    if (entry === undefined || entry.sideTaskOf !== parentId) {
      return fail('invalid_anchor', 'side task does not belong to this session')
    }
    try {
      // Never activates: opening from the phone must not steal the PC focus.
      const side = await this._sessions.resumeSession(sideTaskId, { activate: false })
      return ok(toNewSessionResult(side))
    } catch (err) {
      return this._commandFailure(err, 'openSideTask')
    }
  }

  async deleteSideTask(localId: string, sideTaskId: string): Promise<MobileBridgeResult<void>> {
    await this._ensureHistory()
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const parentId = session.sessionIdOnAgent.get()
    if (parentId === undefined) return fail('invalid_anchor', 'session has no durable id')
    const entry = this._history.get(sideTaskId)
    if (entry === undefined || entry.sideTaskOf !== parentId) {
      return fail('invalid_anchor', 'side task does not belong to this session')
    }
    const ids = collectSideTaskDescendants(this._history.list(), sideTaskId)
    try {
      await deleteSideTasks(ids, this._sessions, this._history, this._editorGroups)
      return ok(undefined)
    } catch (err) {
      return this._commandFailure(err, 'deleteSideTask')
    }
  }

  async previewDelivery(
    localId: string,
    durableId?: string,
  ): Promise<MobileBridgeResult<MobileDeliveryPreview>> {
    await this._ensureDelivery()
    const session =
      this._liveSession(localId) ?? (durableId ? this._liveSession(durableId) : undefined)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const result = await this._delivery.preview(session.id)
    if (!result.ok) return this._deliveryFailure(result.error)
    return ok(this._toMobileDeliveryPreview(result.preview))
  }

  async startDelivery(
    localId: string,
    expectation: MobileDeliveryExpectation,
    durableId?: string,
  ): Promise<MobileBridgeResult<MobileDeliveryStartResult>> {
    await this._ensureDelivery()
    const session =
      this._liveSession(localId) ?? (durableId ? this._liveSession(durableId) : undefined)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const result = await this._delivery.startInBackground(session.id, expectation)
    if (!result.ok) return this._deliveryFailure(result.error)
    return ok(result.value)
  }

  async getDelivery(
    localId: string,
    deliveryId: string,
  ): Promise<MobileBridgeResult<MobileDeliveryDetail>> {
    await this._ensureDelivery()
    const record = this._delivery.getRecord(deliveryId)
    if (record === undefined || !this._deliveryBelongsToSession(record, localId)) {
      return fail('delivery_not_found', 'unknown delivery')
    }
    const detail = this._delivery.getDetail(deliveryId)
    if (detail === undefined) return fail('delivery_not_found', 'unknown delivery')
    return ok(this._toMobileDeliveryDetail(detail))
  }

  async confirmDeliveryPush(
    localId: string,
    deliveryId: string,
  ): Promise<MobileBridgeResult<void>> {
    return this._runDelivery(localId, deliveryId, () =>
      this._delivery.confirmPushInBackground(deliveryId),
    )
  }

  async retryDelivery(localId: string, deliveryId: string): Promise<MobileBridgeResult<void>> {
    return this._runDelivery(localId, deliveryId, () => this._delivery.retry(deliveryId))
  }

  async undoDelivery(localId: string, deliveryId: string): Promise<MobileBridgeResult<void>> {
    return this._runDelivery(localId, deliveryId, () => this._delivery.undo(deliveryId))
  }

  async openDeliveryMainWorktree(
    localId: string,
    deliveryId: string,
  ): Promise<MobileBridgeResult<void>> {
    return this._runDelivery(localId, deliveryId, () => this._delivery.openMainWorktree(deliveryId))
  }

  async previewPushBranch(
    localId: string,
    durableId?: string,
  ): Promise<MobileBridgeResult<MobilePushBranchPreview>> {
    const session =
      this._liveSession(localId) ?? (durableId ? this._liveSession(durableId) : undefined)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const result = await this._branchPush.preview(session.id)
    if (!result.ok) return this._pushFailure(result.error)
    return ok(this._toMobilePushBranchPreview(result.value))
  }

  async pushBranch(
    localId: string,
    expectation: MobilePushBranchExpectation,
    durableId?: string,
  ): Promise<MobileBridgeResult<MobilePushBranchResult>> {
    const session =
      this._liveSession(localId) ?? (durableId ? this._liveSession(durableId) : undefined)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const result = await this._branchPush.push(session.id, expectation)
    if (!result.ok) return this._pushFailure(result.error)
    return ok({
      branch: result.value.branch,
      remote: result.value.remote,
      remoteBranch: result.value.remoteBranch,
      head: result.value.head,
      published: result.value.published,
    })
  }

  async getDeliveryContext(
    localId: string,
    durableId?: string,
  ): Promise<MobileBridgeDeliveryContext | undefined> {
    await this._ensureDelivery()
    const session =
      this._liveSession(localId) ?? (durableId ? this._liveSession(durableId) : undefined)
    const context = this._delivery.getContext(
      session?.id ?? localId,
      durableId ?? session?.sessionIdOnAgent.get(),
    )
    if (context !== undefined) {
      return {
        sourceCwd: context.sourceCwd,
        ...(context.authority !== undefined ? { authority: context.authority } : {}),
        ...(context.deliveryId !== undefined ? { deliveryId: context.deliveryId } : {}),
        ...(context.phase !== undefined ? { phase: context.phase } : {}),
        ...(context.mainWorktree !== undefined ? { mainWorktree: context.mainWorktree } : {}),
      }
    }
    if (session === undefined) return undefined
    const cwd = session.cwd
    if (cwd === undefined || cwd.length === 0) return undefined
    return {
      sourceCwd: cwd,
      ...(session.authority !== undefined ? { authority: session.authority } : {}),
    }
  }

  async listActiveDeliveries(): Promise<readonly MobileBridgeDeliveryContext[]> {
    await this._ensureDelivery()
    return this._delivery.listActiveContexts().map((context) => ({
      sourceCwd: context.sourceCwd,
      ...(context.authority !== undefined ? { authority: context.authority } : {}),
      ...(context.deliveryId !== undefined ? { deliveryId: context.deliveryId } : {}),
      ...(context.phase !== undefined ? { phase: context.phase } : {}),
      ...(context.mainWorktree !== undefined ? { mainWorktree: context.mainWorktree } : {}),
    }))
  }

  private async _runDelivery(
    localId: string,
    deliveryId: string,
    action: () => Promise<
      | { readonly ok: true; readonly value: void }
      | { readonly ok: false; readonly error: SessionDeliveryError }
    >,
  ): Promise<MobileBridgeResult<void>> {
    await this._ensureDelivery()
    const record = this._delivery.getRecord(deliveryId)
    if (record === undefined || !this._deliveryBelongsToSession(record, localId)) {
      return fail('delivery_not_found', 'unknown delivery')
    }
    const result = await action()
    return result.ok ? ok(undefined) : this._deliveryFailure(result.error)
  }

  private _deliveryBelongsToSession(
    record: {
      readonly source: { readonly sessionLocalId?: string; readonly sessionDurableId?: string }
    },
    localId: string,
  ): boolean {
    if (record.source.sessionLocalId === localId) return true
    if (record.source.sessionDurableId === localId) return true
    const session = this._liveSession(localId)
    if (session === undefined) return false
    const durableId = session.sessionIdOnAgent.get()
    return (
      record.source.sessionLocalId === session.id ||
      (durableId !== undefined && record.source.sessionDurableId === durableId)
    )
  }

  private _deliveryFailure(error: SessionDeliveryError): MobileBridgeCommandError {
    const message = clipDeliveryText(error.message)
    switch (error.code) {
      case 'busy':
      case 'lock_held':
        return fail('delivery_busy', message)
      case 'not_found':
        return fail('delivery_not_found', message)
      case 'conflict':
        return fail('delivery_conflict', message)
      case 'unsupported':
      case 'merge_commit_unsupported':
        return fail('delivery_unsupported', message)
      default:
        return fail('internal', message)
    }
  }

  private _pushFailure(error: SessionDeliveryError): MobileBridgeCommandError {
    const message = clipDeliveryText(error.message)
    switch (error.code) {
      case 'busy':
        return fail('push_busy', message)
      case 'session_running':
        return fail('session_busy', message)
      case 'remote_moved':
      case 'remote_diverged':
      case 'head_mismatch':
      case 'upstream_changed':
        return fail('push_conflict', message)
      case 'unsupported':
      case 'not_a_repository':
      case 'no_remote':
      case 'nothing_to_push':
      case 'detached_source':
      case 'invalid_branch':
      case 'source_in_progress':
        return fail('push_unsupported', message)
      default:
        return fail('push_failed', message)
    }
  }

  private _toMobilePushBranchPreview(preview: SessionBranchPushPreview): MobilePushBranchPreview {
    return {
      source: {
        worktreeName: worktreeName(preview.source.worktree),
        branch: preview.source.branch,
        head: preview.source.head,
        dirty: preview.source.dirty,
        changedFileCount: preview.source.changedFileCount,
        untrackedCount: preview.source.untrackedCount,
        ...(preview.source.pendingOperation !== undefined
          ? { pendingOperation: clipDeliveryText(preview.source.pendingOperation) }
          : {}),
        isMainWorktree: preview.source.isMainWorktree,
      },
      remote: {
        name: clipDeliveryText(preview.remote.name),
        branch: clipDeliveryText(preview.remote.branch),
        exists: preview.remote.exists,
        ...(preview.remote.head !== undefined ? { head: preview.remote.head } : {}),
        ahead: preview.remote.ahead,
        behind: preview.remote.behind,
      },
      blockers: preview.blockers.map((error) => ({
        code: error.code,
        message: clipDeliveryText(error.message),
        ...(error.detail !== undefined ? { detail: clipDeliveryText(error.detail) } : {}),
      })),
      warnings: preview.warnings.map(clipDeliveryText),
      expectation: {
        branch: preview.expectation.branch,
        head: preview.expectation.head,
        remote: preview.expectation.remote,
        remoteBranch: preview.expectation.remoteBranch,
        ...(preview.expectation.remoteHead !== undefined
          ? { remoteHead: preview.expectation.remoteHead }
          : {}),
      },
    }
  }

  private _toMobileDeliveryDetail(detail: SessionDeliveryDetail): MobileDeliveryDetail {
    return {
      ...detail,
      summary: toMobileDeliverySummary(detail.summary),
      conflictFiles: detail.conflictFiles.map(clipDeliveryText),
      ...(detail.generatedMessage !== undefined
        ? { generatedMessage: clipDeliveryText(detail.generatedMessage) }
        : {}),
      syncResults: detail.syncResults.map((result) => ({
        name: clipDeliveryText(result.name),
        ...(result.branch !== undefined ? { branch: clipDeliveryText(result.branch) } : {}),
        status: result.status,
        ...(result.error !== undefined ? { error: clipDeliveryText(result.error) } : {}),
      })),
    }
  }

  private _toMobileDeliveryPreview(preview: SessionDeliveryPreview): MobileDeliveryPreview {
    return {
      source: {
        worktreeName: worktreeName(preview.source.worktree),
        ...(preview.source.branch !== undefined ? { branch: preview.source.branch } : {}),
        head: preview.source.head,
        dirty: preview.source.dirty,
        changedFileCount: preview.source.changedFileCount,
        untrackedCount: preview.source.untrackedCount,
        ...(preview.source.pendingOperation !== undefined
          ? { pendingOperation: preview.source.pendingOperation }
          : {}),
        isMainWorktree: preview.source.isMainWorktree,
      },
      target: {
        mainWorktreeName: worktreeName(preview.target.mainWorktree),
        mainBranch: preview.target.mainBranch,
        remote: preview.target.remote,
        remoteBranch: preview.target.remoteBranch,
        upstreamRef: preview.target.upstreamRef,
        baseSha: preview.target.baseSha,
        mainHead: preview.expectation.mainHead,
        upstreamHead: preview.target.upstreamHead,
        aheadOfUpstream: preview.target.aheadOfUpstream,
      },
      commits: preview.commits,
      blockers: preview.blockers.map(toMobileDeliveryError),
      warnings: preview.warnings.map(clipDeliveryText),
      forkSupported: preview.forkSupported,
      expectation: preview.expectation,
    }
  }

  async listWorkspaces(): Promise<readonly MobileWorkspaceCandidate[]> {
    const current = this._workspace.current
    if (current === null) return []
    return [
      {
        folder: current.folder.toString(),
        name: current.name,
        ...(current.folder.authority ? { authority: current.folder.authority } : {}),
        isOpen: true,
      },
    ]
  }

  async listAgents(): Promise<readonly MobileAgentCandidate[]> {
    // Same cold-start hydration reason as `newSession`: return the full list.
    await this._userSettings.whenInitialized
    const defaultId = this._agents.defaultAgentId()
    return this._agents.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      isDefault: agent.id === defaultId,
    }))
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    for (const search of this._promptRefSearches.values()) {
      search.cancel()
      search.dispose()
    }
    this._promptRefSearches.clear()
    void this.stopStreaming()
    void this.stopAttention()
    this._onDidChange.dispose()
    super.dispose()
  }

  private _attentionEventFor(
    session: IAcpSession,
    attentionKind: MobileBridgeAttentionEvent['attentionKind'],
  ): MobileBridgeAttentionEvent {
    const durableId = session.sessionIdOnAgent.get()
    const agentName = this._agentNameFor(session.agentId)
    const permissionTitle = session.pendingPermission.get()?.title
    return {
      kind: 'attention',
      localId: session.id,
      ...(durableId !== undefined ? { durableId } : {}),
      attentionKind,
      title: this._titleFor(session),
      ...(agentName !== undefined ? { agentName } : {}),
      ...(permissionTitle !== undefined && permissionTitle !== '' ? { permissionTitle } : {}),
    }
  }

  private _liveSession(localId: string): IAcpSession | undefined {
    const session = this._sessions.getById(localId)
    return session !== undefined && isResidentLive(session) ? session : undefined
  }

  private _pendingPermission(
    session: IAcpSession,
    requestId: string,
  ): AcpPendingPermission | undefined {
    const pending = session.pendingPermission.get()
    return pending !== undefined && pending.requestId === requestId ? pending : undefined
  }

  private _pendingElicitation(
    session: IAcpSession,
    requestId: string,
  ): AcpPendingElicitation | undefined {
    const pending = session.pendingElicitation.get()
    return pending !== undefined && pending.requestId === requestId ? pending : undefined
  }

  private async _run(
    localId: string,
    action: (session: IAcpSession) => Promise<void>,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    try {
      await action(session)
      return ok(undefined)
    } catch (err) {
      return fail('internal', String(err))
    }
  }

  private _scheduleSync(): void {
    if (this._syncScheduled || !this._streaming) return
    this._syncScheduled = true
    // Deferred so a new per-session autorun is never created inside the root
    // autorun's own tracking context.
    this._syncHandle = setTimeout(() => {
      this._syncHandle = undefined
      this._syncScheduled = false
      this._syncNow()
    }, 0)
  }

  private _syncNow(): void {
    if (!this._streaming) return
    const wanted = new Map<string, IAcpSession>()
    for (const session of this._sessions.sessions.get()) {
      if (isResidentLive(session)) wanted.set(session.id, session)
    }

    const removes: { localId: string; durableId?: string }[] = []
    for (const [localId, stream] of this._streams) {
      if (wanted.has(localId)) continue
      const durableId = stream.session.sessionIdOnAgent.get()
      removes.push({ localId, ...(durableId !== undefined ? { durableId } : {}) })
      this._disposeStream(stream)
      this._streams.delete(localId)
      this._resetDraftSync(localId)
      this._logger.debug(`mobile bridge dropped session ${localId}`)
    }
    if (removes.length > 0) this._emit({ kind: 'inbox', upserts: [], removes })

    for (const [localId, session] of wanted) {
      if (this._streams.has(localId)) continue
      this._createStream(session)
      this._logger.debug(`mobile bridge watching session ${localId}`)
    }
  }

  private _createStream(session: IAcpSession): void {
    const stream: SessionStream = {
      localId: session.id,
      session,
      watcher: undefined,
      timer: undefined,
      timerDelay: MOBILE_BRIDGE_THROTTLE_MS,
      disposed: false,
      pending: undefined,
      publishedTimeline: [],
      publishedPlan: [],
      publishedConfigOptions: [],
      publishedCommands: [],
      publishedPermission: undefined,
      publishedElicitation: undefined,
      publishedSummary: undefined,
      publishedMessageChars: 0,
      lastPermissionSettle: undefined,
      settleWatcher: undefined,
    }
    this._streams.set(session.id, stream)
    stream.watcher = autorun((r) => {
      if (stream.disposed) return
      const snapshot = toBridgeSnapshot(session, this._projectionOptions(session, r), r)
      if (snapshot.pendingPermission !== undefined) this._ensureSettleWatcher(stream)
      stream.pending = snapshot
      this._scheduleFlush(stream, snapshot)
    })
    if (stream.pending !== undefined) this._scheduleFlush(stream, stream.pending)
  }

  /**
   * Subscribe to settlement events only while a permission is pending: the
   * cleared event needs the reason/source, but an always-on subscription is a
   * disposable the bridge would otherwise keep for the whole session lifetime.
   */
  private _ensureSettleWatcher(stream: SessionStream): void {
    if (stream.settleWatcher !== undefined) return
    stream.settleWatcher = stream.session.onDidSettlePermission((event) => {
      stream.lastPermissionSettle = {
        requestId: event.requestId,
        reason: event.reason as MobilePermissionSettleReason,
        source: event.source as MobilePermissionSettleSource,
      }
    })
  }

  private _dropSettleWatcher(stream: SessionStream): void {
    stream.settleWatcher?.dispose()
    stream.settleWatcher = undefined
  }

  private _scheduleFlush(stream: SessionStream, snapshot: MobileBridgeSessionSnapshot): void {
    const delay = this._delayFor(stream, snapshot)
    if (stream.timer !== undefined) {
      if (delay <= stream.timerDelay) return
      clearTimeout(stream.timer)
    }
    stream.timerDelay = delay
    stream.timer = setTimeout(() => {
      stream.timer = undefined
      this._flush(stream)
    }, delay)
  }

  private _delayFor(stream: SessionStream, snapshot: MobileBridgeSessionSnapshot): number {
    let totalChars = 0
    for (const item of snapshot.timeline) {
      if (item.kind === 'message') totalChars += item.text.length
    }
    return totalChars - stream.publishedMessageChars > MOBILE_BRIDGE_LARGE_DELTA_CHARS
      ? MOBILE_BRIDGE_LARGE_THROTTLE_MS
      : MOBILE_BRIDGE_THROTTLE_MS
  }

  private _flush(stream: SessionStream): void {
    if (stream.disposed || stream.pending === undefined) return
    if (stream.timer !== undefined) {
      clearTimeout(stream.timer)
      stream.timer = undefined
    }
    const next = stream.pending
    stream.pending = undefined

    const events: MobileBridgeSessionEvent[] = []
    const timelineDiff = diffTimeline(stream.publishedTimeline, next.timeline)
    events.push(...timelineDiff.events)
    const planEvent = diffPlan(stream.publishedPlan, next.plan)
    if (planEvent !== undefined) events.push(planEvent)
    const configEvent = diffConfigOptions(stream.publishedConfigOptions, next.configOptions)
    if (configEvent !== undefined) events.push(configEvent)
    const commandsEvent = diffAvailableCommands(stream.publishedCommands, next.availableCommands)
    if (commandsEvent !== undefined) events.push(commandsEvent)
    const previousPermission = stream.publishedPermission
    const permissionCleared =
      previousPermission !== undefined &&
      next.pendingPermission?.requestId !== previousPermission.requestId &&
      stream.lastPermissionSettle?.requestId === previousPermission.requestId
        ? stream.lastPermissionSettle
        : undefined
    events.push(...diffPermission(previousPermission, next.pendingPermission, permissionCleared))
    if (permissionCleared !== undefined) stream.lastPermissionSettle = undefined
    if (next.pendingPermission === undefined) {
      stream.lastPermissionSettle = undefined
      this._dropSettleWatcher(stream)
    }
    const elicitationEvent = diffElicitation(stream.publishedElicitation, next.pendingElicitation)
    if (elicitationEvent !== undefined) events.push(elicitationEvent)
    // The stream projects the session only; delivery fields live on this
    // service, so they must be attached here too or every flush would upsert
    // a summary that makes the phone drop its「交付」badge.
    const summary = this._withDelivery(stream.session, next.summary)
    // A finished turn may have committed or edited files; do not let the probe
    // TTL hide the newly deliverable work until the next sweep.
    if (
      stream.publishedSummary !== undefined &&
      stream.publishedSummary.status !== 'idle' &&
      summary.status === 'idle'
    ) {
      this._schedulePendingWorkRefresh(stream.session, true)
    }
    const summaryChangedNow =
      stream.publishedSummary !== undefined
        ? summaryChanged(stream.publishedSummary, summary)
        : false
    if (summaryChangedNow) {
      events.push({ type: 'summary_changed', summary })
    }

    if (events.length > 0) {
      const delta: MobileBridgeSessionDelta = {
        kind: 'session_delta',
        localId: stream.localId,
        events,
      }
      this._emit(delta)
    }

    if (stream.publishedSummary === undefined || summaryChangedNow) {
      this._emit({ kind: 'inbox', upserts: [summary], removes: [] })
    }

    stream.publishedTimeline = next.timeline
    stream.publishedPlan = next.plan
    stream.publishedConfigOptions = next.configOptions
    stream.publishedCommands = next.availableCommands
    stream.publishedPermission = next.pendingPermission
    stream.publishedElicitation = next.pendingElicitation
    stream.publishedSummary = summary
    stream.publishedMessageChars = next.timeline.reduce(
      (sum, item) => (item.kind === 'message' ? sum + item.text.length : sum),
      0,
    )
  }

  private _disposeStream(stream: SessionStream): void {
    stream.disposed = true
    if (stream.timer !== undefined) {
      clearTimeout(stream.timer)
      stream.timer = undefined
    }
    stream.watcher?.dispose()
    stream.watcher = undefined
    this._dropSettleWatcher(stream)
    stream.pending = undefined
  }

  private _emit(event: MobileBridgeEvent): void {
    this._onDidChange.fire(event)
  }

  private _summaryFor(session: IAcpSession): MobileBridgeSessionSummary {
    const base = toBridgeSnapshot(session, this._projectionOptions(session)).summary
    return this._withDelivery(session, base)
  }

  private _withDelivery(
    session: IAcpSession,
    summary: MobileBridgeSessionSummary,
  ): MobileBridgeSessionSummary {
    const delivery = this._delivery.getSummaryForSession(session.id, session.sessionIdOnAgent.get())
    const eligible = this._delivery.isAvailable(session)
    if (eligible) this._schedulePendingWorkRefresh(session)
    const deliveryAvailable = eligible && this._delivery.hasDeliverableChanges(session)
    return {
      ...summary,
      ...(delivery !== undefined ? { delivery: toMobileDeliverySummary(delivery) } : {}),
      ...(deliveryAvailable ? { deliveryAvailable: true } : {}),
    }
  }

  private _schedulePendingWorkRefresh(session: IAcpSession, force = false): void {
    void this._delivery
      .refreshDeliverableChanges(session, force ? { force: true } : undefined)
      .then((changed) => {
        if (!changed || this._disposed) return
        this._publishPendingWorkFor(session)
      })
      .catch(() => undefined)
  }

  private _publishPendingWorkFor(session: IAcpSession): void {
    const key = this._pendingWorkKey(session)
    if (key === undefined) return
    for (const candidate of this._sessions.sessions.get()) {
      if (!isResidentLive(candidate)) continue
      if (this._pendingWorkKey(candidate) !== key) continue
      this._publishSummary(candidate)
    }
  }

  private _pendingWorkKey(session: IAcpSession): string | undefined {
    const cwd = session.cwd
    if (cwd === undefined || cwd.length === 0) return undefined
    return `${session.authority ?? ''}|${this._uriIdentity.getPathComparisonKey(cwd)}`
  }

  private _publishSummary(session: IAcpSession): void {
    const summary = this._summaryFor(session)
    const stream = this._streams.get(session.id)
    if (
      stream !== undefined &&
      stream.publishedSummary !== undefined &&
      !summaryChanged(stream.publishedSummary, summary)
    ) {
      return
    }
    if (stream !== undefined) stream.publishedSummary = summary
    this._emit({
      kind: 'session_delta',
      localId: session.id,
      events: [{ type: 'summary_changed', summary }],
    })
    this._emit({ kind: 'inbox', upserts: [summary], removes: [] })
  }

  private _sweepPendingWork(): void {
    if (this._disposed || !this._streaming) return
    const seen = new Set<string>()
    for (const session of this._sessions.sessions.get()) {
      if (!isResidentLive(session) || !this._delivery.isAvailable(session)) continue
      if (this._delivery.isDeliveryBusyForSession(session)) continue
      const key = this._pendingWorkKey(session)
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      this._schedulePendingWorkRefresh(session)
    }
  }

  private async _ensureDelivery(): Promise<void> {
    try {
      await this._delivery.initialize()
    } catch (err) {
      this._logger.warn(`mobile bridge delivery initialization failed: ${String(err)}`)
    }
  }

  private _onDeliveryChanged(change: SessionDeliveryChange): void {
    const session =
      (change.sessionLocalId !== undefined
        ? this._liveSession(change.sessionLocalId)
        : undefined) ??
      (change.sessionDurableId !== undefined
        ? this._liveSession(change.sessionDurableId)
        : undefined)
    if (session === undefined) return
    this._publishSummary(session)
    this._schedulePendingWorkRefresh(session, true)
  }

  /**
   * Side tasks have their own entry point (the parent's side-task sheet),
   * archived rows are hidden by default on the PC, and an agent never persisted
   * a session that never sent a message. Cross-worktree rows must not leak into
   * this window's catalog.
   */
  private _isResumableHistoryEntry(entry: AcpSessionHistoryEntry): boolean {
    return isResumableHistoryEntry(
      entry,
      this._currentCwd(),
      this._currentAuthority(),
      this._uriIdentity,
    )
  }

  private _currentCwd(): string | undefined {
    return this._workspace.current?.folder.fsPath
  }

  private _currentAuthority(): string | undefined {
    const folder = this._workspace.current?.folder
    if (folder === undefined || folder.scheme !== REMOTE_SCHEME) return undefined
    return folder.authority || undefined
  }

  private async _ensureHistory(): Promise<void> {
    try {
      await this._history.initialize()
    } catch (err) {
      this._logger.warn(`mobile bridge history initialization failed: ${String(err)}`)
    }
  }

  private _commandFailure(err: unknown, action: string): MobileBridgeCommandError {
    const message = err instanceof Error ? err.message : String(err)
    this._logger.warn(`mobile ${action} failed: ${message}`)
    if (err instanceof AcpForeignWorktreeError) {
      return fail('forbidden_operation', 'open the session in its own worktree first')
    }
    return fail('internal', `${action} failed`)
  }

  private _projectionOptions(session: IAcpSession, r?: IReader): SessionProjectionOptions {
    const title = this._titleFor(session, r)
    const agentName = this._agentNameFor(session.agentId)
    const durableId = r ? session.sessionIdOnAgent.read(r) : session.sessionIdOnAgent.get()
    const entries = r ? this._history.entries.read(r) : this._history.entries.get()
    const entry = durableId !== undefined ? entries.find((row) => row.id === durableId) : undefined
    let childCount = 0
    if (durableId !== undefined) {
      for (const row of entries) {
        if (row.sideTaskOf === durableId) childCount++
      }
    }
    return {
      title,
      ...(agentName !== undefined ? { agentName } : {}),
      // Inbox rows show the session's last real activity, not when this
      // projection happened to run — otherwise every re-subscribe (phone
      // refresh) would relabel all rows as "just now".
      ...(entry !== undefined ? { now: entry.lastUsedAt } : {}),
      ...(entry?.sideTaskOf !== undefined ? { sideTaskOf: entry.sideTaskOf } : {}),
      ...(childCount > 0 ? { sideTaskChildCount: childCount } : {}),
    }
  }

  private _titleFor(session: IAcpSession, r?: IReader): string {
    const durableId = r ? session.sessionIdOnAgent.read(r) : session.sessionIdOnAgent.get()
    const entries = r ? this._history.entries.read(r) : this._history.entries.get()
    const id = durableId ?? session.id
    for (const entry of entries) {
      if (entry.id === id) return entry.title
    }
    return session.title
  }

  private _agentNameFor(agentId: string): string | undefined {
    if (this._agentNames.has(agentId)) return this._agentNames.get(agentId)
    let name: string | undefined
    try {
      name = this._agents.get(agentId).name
    } catch {
      name = undefined
    }
    this._agentNames.set(agentId, name)
    return name
  }
}

function ok<T>(value: T): MobileBridgeResult<T> {
  return { ok: true, value }
}

/** Phone-facing delivery text; raw git stderr (absolute paths) never leaves the PC. */
const DELIVERY_TEXT_LIMIT = 300

function clipDeliveryText(text: string): string {
  return text.length > DELIVERY_TEXT_LIMIT ? `${text.slice(0, DELIVERY_TEXT_LIMIT - 1)}…` : text
}

function toMobileDeliveryError(error: SessionDeliveryError): MobileDeliveryError {
  return { code: error.code, message: clipDeliveryText(error.message) }
}

function toMobileDeliverySummary(summary: SessionDeliverySummary): MobileDeliverySummary {
  return {
    deliveryId: summary.deliveryId,
    phase: summary.phase,
    commitCount: summary.commitCount,
    dirtySource: summary.dirtySource,
    mainBranch: summary.mainBranch,
    updatedAt: summary.updatedAt,
    ...(summary.error !== undefined ? { error: toMobileDeliveryError(summary.error) } : {}),
    canConfirmPush: summary.canConfirmPush,
    canRetry: summary.canRetry,
    canUndo: summary.canUndo,
    sync: summary.sync,
  }
}

function fail(code: MobileBridgeCommandError['code'], message: string): MobileBridgeCommandError {
  return { ok: false, code, message }
}

/** Mirrors agentRewindPickItems.ts: user turns only, auto-retry turns excluded. */
function findUserAnchor(
  messages: readonly AcpMessage[],
  messageId: string,
): AcpMessage | undefined {
  return messages.find(
    (message) =>
      message.role === 'user' && message.autoRetry !== true && message.messageId === messageId,
  )
}

function firstUserMessage(messages: readonly AcpMessage[]): AcpMessage | undefined {
  return messages.find((message) => message.role === 'user')
}

function toNewSessionResult(session: IAcpSession): MobileBridgeNewSessionResult {
  const durableId = session.sessionIdOnAgent.get()
  return { localId: session.id, ...(durableId !== undefined ? { durableId } : {}) }
}

/** Same trim / 8000-char clip / 60-char label as the desktop side-task command. */
function prepareSideTaskQuote(
  quote: string | undefined,
): { text: string; label: string } | undefined {
  const trimmed = quote?.trim() ?? ''
  if (trimmed.length === 0) return undefined
  const clipped =
    trimmed.length > MAX_SIDE_TASK_QUOTE_LENGTH
      ? `${trimmed.slice(0, MAX_SIDE_TASK_QUOTE_LENGTH)}…`
      : trimmed
  return { text: clipped, label: clipped.replace(/\s+/g, ' ').slice(0, 60) }
}

function isResidentLiveSession(session: IAcpSession | undefined): boolean {
  return session !== undefined && isResidentLive(session)
}

function attachmentKey(draft: MobileBridgeDraft | undefined): string {
  if (draft === undefined) return ''
  return JSON.stringify([
    draft.images.map((image) => image.id),
    (draft.files ?? []).map((file) => file.id),
  ])
}
