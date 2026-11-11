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
  Disposable,
  Emitter,
  IEditorGroupsService,
  IFileService,
  ILoggerService,
  IUriIdentityService,
  IWorkspaceService,
  REMOTE_SCHEME,
  URI,
  type IDisposable,
  type ILogger,
  type IReader,
  type CancellationToken,
} from '@universe-editor/platform'
import {
  clampText,
  isConfigValueAllowedOnMobile,
  isHighRiskPermissionOption,
  isPreviewableImageMimeType,
  MAX_HISTORY_PROMPT_LENGTH,
  MAX_ID_LENGTH,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_MESSAGE_IMAGE_INDEX,
  MAX_SIDE_TASK_QUOTE_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORKSPACE_IMAGE_BYTES,
  MAX_WORKSPACE_NAME_LENGTH,
  type MobileAgentCandidate,
  type MobileElicitationAction,
  type MobileElicitationContentValue,
  type MobileRewindPreview,
  type MobileRewindResult,
  type MobileSideTaskSummary,
  type MobileWorkspaceCandidate,
  type MobileToolCallDetail,
} from '@universe-editor/mobile-protocol'
import {
  MEDIA_TRUNCATED_META_KEY,
  truncateDiffSideText,
  truncateToolTextBlock,
} from '@universe-editor/acp-view-model'
import { isResumableHistoryEntry } from '../../../shared/mobileGateway/sessionHistoryFilter.js'
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
  IMobileBridgeService,
} from '../../../shared/ipc/mobileGatewayService.js'
import {
  AcpPromptDraftCache,
  type AcpPromptDraft,
  type AcpPromptDraftChange,
} from '../acp/session/acpPromptDraftCache.js'
import { mergeBridgeDraft, toBridgeDraft } from './mobileDraftSync.js'
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
import { deleteSessionPlan, planSessionRemoval } from '../acp/session/sessionRemoval.js'
import { deleteSideTasks } from '../acp/session/sideTaskRemoval.js'
import type {
  MobilePermissionSettleReason,
  MobilePermissionSettleSource,
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
  private readonly _agentNames = new Map<string, string | undefined>()
  private _attentionSubscription: IDisposable | undefined
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
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'mobileBridge', name: 'Mobile Bridge' })
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
    const session = this._sessions.getById(localId)
    if (session === undefined || !isResidentLive(session)) return undefined
    // Emit any coalesced delta first so the caller cannot receive an event that
    // precedes this snapshot but describes state the snapshot already carries.
    const stream = this._streams.get(session.id)
    if (stream !== undefined) this._flush(stream)
    const snapshot = toBridgeSnapshot(session, this._projectionOptions(session))
    const draft = this._draftFor(session)
    return draft === undefined ? snapshot : { ...snapshot, draft }
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
  }

  async stopStreaming(): Promise<void> {
    if (!this._streaming) return
    this._streaming = false
    this._logger.debug('mobile bridge streaming stopped')
    this._rootWatcher?.dispose()
    this._rootWatcher = undefined
    this._draftSubscription?.dispose()
    this._draftSubscription = undefined
    for (const timer of this._draftTimers.values()) clearTimeout(timer)
    this._draftTimers.clear()
    this._publishedDrafts.clear()
    this._publishedDraftAttachments.clear()
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
    const next = mergeBridgeDraft(AcpPromptDraftCache.load(session.id), draft)
    if (next === undefined) {
      AcpPromptDraftCache.clear(session.id, { source: 'remote' })
    } else {
      AcpPromptDraftCache.save(session.id, next, { source: 'remote' })
    }
    return ok(undefined)
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
    AcpPromptDraftCache.clear(session.id, { source: 'remote' })
    return ok(undefined)
  }

  private _draftFor(session: IAcpSession): MobileBridgeDraft | undefined {
    const draft = AcpPromptDraftCache.load(session.id)
    return draft === undefined ? undefined : toBridgeDraft(draft)
  }

  private _onDraftChanged(event: AcpPromptDraftChange): void {
    if (!this._streaming) return
    const session = this._liveSession(event.sessionId)
    if (session === undefined) return
    // A remote apply/clear supersedes a local publish that has not fired yet.
    if (event.source !== 'local') {
      this._cancelDraftTimer(session.id)
      return
    }
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
        // The cache may have been replaced by a remote apply while queued.
        const latest = this._draftFor(session)
        const latestKey = JSON.stringify(latest ?? null)
        if (latestKey !== key) return
        this._publishDraft(session, latest, latestKey, attachmentKey(latest))
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

  async sendPrompt(
    localId: string,
    text: string,
    attachments: readonly MobileBridgePromptAttachment[] = [],
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
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
    // Return once the prompt is accepted by the session (append + queue); the
    // actual agent round-trip is intentionally not awaited.
    const dispatch =
      images.length === 0 && files.length === 0
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
    allowHighRisk: boolean,
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
    if (!allowHighRisk && isHighRiskPermissionOption(option)) {
      return fail('forbidden_operation', 'durable permission grants are not allowed from mobile')
    }
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
    allowHighRisk: boolean,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (!allowHighRisk && !isConfigValueAllowedOnMobile(value)) {
      return fail('forbidden_operation', 'bypass permissions cannot be enabled from mobile')
    }
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
    workspace: { folder: string; authority?: string },
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
    try {
      const session = await this._sessions.createSession(agentId, {
        cwd: folder.fsPath,
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
    // Same plan → execute pipeline as the PC "Delete Agent Session" command;
    // the phone already confirmed, so only the execution half runs here.
    const plan = planSessionRemoval(this._sessions, this._history, localId)
    await deleteSessionPlan(plan, this._sessions, this._history, this._editorGroups)
    return ok(undefined)
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
    const summaryChangedNow =
      stream.publishedSummary !== undefined
        ? summaryChanged(stream.publishedSummary, next.summary)
        : false
    if (summaryChangedNow) {
      events.push({ type: 'summary_changed', summary: next.summary })
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
      this._emit({ kind: 'inbox', upserts: [next.summary], removes: [] })
    }

    stream.publishedTimeline = next.timeline
    stream.publishedPlan = next.plan
    stream.publishedConfigOptions = next.configOptions
    stream.publishedCommands = next.availableCommands
    stream.publishedPermission = next.pendingPermission
    stream.publishedElicitation = next.pendingElicitation
    stream.publishedSummary = next.summary
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
    return toBridgeSnapshot(session, this._projectionOptions(session)).summary
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
