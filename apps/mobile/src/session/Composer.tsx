import {
  MAX_ATTACHMENT_BYTES_PER_PROMPT,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS_PER_PROMPT,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PROMPT_LENGTH,
  isMobileImageMimeType,
  type MobileAttachmentKind,
  type MobileAttachmentUploadResult,
  type MobileAvailableCommand,
  type MobileDraftFileRef,
  type MobileDraftImageRef,
  type MobileDraftState,
  type MobilePromptRef,
  type MobilePromptRefResolveKind,
  type MobilePromptRefSuggestion,
  type MobilePromptRefTrigger,
  type ResolvePromptRefResult,
} from '@universe-editor/mobile-protocol'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import { errorCode } from '../errors.js'
import { isSendableMobilePromptRef } from '../state/commandResults.js'
import { ImagePreviewOverlay } from '../components/ImagePreviewOverlay.js'
import { commandErrorText, formatAttachmentSize, strings } from '../strings.js'
import { ComposerAttachmentChip } from './ComposerAttachmentChip.js'
import { PROMPT_REF_LIST_ID, PromptRefPanel, promptRefOptionId } from './PromptRefPanel.js'
import {
  applyTextEdit,
  collectPlacedRefs,
  extractHashQuery,
  extractMentionQuery,
  insertPromptRef,
  type PlacedPromptRef,
  type PromptRefQuery,
} from './promptRefs.js'
import {
  SLASH_COMMAND_LIST_ID,
  SlashCommandPanel,
  slashCommandOptionId,
} from './SlashCommandPanel.js'
import {
  applySlashCommand,
  extractSlashQuery,
  filterSlashCommands,
  type SlashQuery,
} from './slashCommands.js'
import { useAutoGrowTextarea } from './useAutoGrowTextarea.js'

const MAX_ROWS = 6
const LINE_HEIGHT_PX = 22
const MAX_HEIGHT_PX = MAX_ROWS * LINE_HEIGHT_PX
const DRAFT_PREFIX = 'universe.mobile.draft.v2:'
const LEGACY_DRAFT_PREFIX = 'universe.mobile.draft:'
/** sessionStorage is small; stale sessions must not crowd out the active draft. */
const MAX_STORED_DRAFTS = 20
const NO_COMMANDS: readonly MobileAvailableCommand[] = []
/** Matches the PC-side publisher; keeps typing from flooding the socket. */
const DRAFT_SYNC_DEBOUNCE_MS = 250
/** Mobile mirror of the desktop popover's `#` debounce. */
const REF_SEARCH_DEBOUNCE_MS = 150
const EMPTY_ID_SET: ReadonlySet<string> = new Set()
const EMPTY_PROMPT_REFS: readonly MobilePromptRefSuggestion[] = []

/**
 * The fields whose changes make this phone the writer. Remote attachment
 * mirrors are deliberately excluded: they move when another client edits and
 * must not look like an unpublished local edit.
 */
function localDraftKey(
  text: string,
  localImages: readonly MobileDraftImageRef[],
  localFiles: readonly MobileDraftFileRef[],
  removedImages: ReadonlySet<string>,
  removedFiles: ReadonlySet<string>,
): string {
  return JSON.stringify([
    text,
    localImages.map((image) => image.id),
    localFiles.map((file) => file.id),
    [...removedImages].sort(),
    [...removedFiles].sort(),
  ])
}

export type ComposerAttachmentStatus = 'uploading' | 'uploaded' | 'failed'

export interface ComposerAttachment {
  readonly key: string
  readonly kind: MobileAttachmentKind
  readonly name: string
  readonly size: number
  readonly mimeType: string
  readonly status: ComposerAttachmentStatus
  readonly id?: string
  /** Local blob: URL of a picked image, so it can be previewed before/after upload. */
  readonly previewUrl?: string
}

export interface ComposerPrefill {
  /** Bumped for every backfill so repeating the same text still applies. */
  readonly token: number
  /** The session that deposited the text; a switched session must not inherit it. */
  readonly sessionKey: string
  readonly text: string
}

/** The `#` token a second step will replace, captured before the RPC. */
interface PromptRefAnchor {
  readonly start: number
  readonly end: number
  readonly anchorText: string
}

/**
 * Inline second step for entries with an open-ended candidate space: commit
 * history for `#Git Commit…`, or a picker the extension opens on the PC for its
 * own `#` entry. The anchor survives independently of the caret.
 */
interface PromptRefSecondStep {
  readonly kind: MobilePromptRefResolveKind
  readonly title: string
  readonly anchor: PromptRefAnchor
  readonly suggestions: readonly MobilePromptRefSuggestion[]
  readonly loading: boolean
  readonly failed: boolean
  readonly loadingText?: string | undefined
  readonly emptyText?: string | undefined
}

export interface ComposerProps {
  readonly sessionKey: string
  readonly readOnly: boolean
  readonly running: boolean
  readonly online: boolean
  readonly imageSupported: boolean
  readonly fileSupported: boolean
  /** Agent-advertised slash commands; empty hides both the button and the panel. */
  readonly commands: readonly MobileAvailableCommand[]
  readonly onUploadAttachment: (
    file: File,
    kind: MobileAttachmentKind,
  ) => Promise<MobileAttachmentUploadResult>
  /** Bytes of a PC-pasted draft picture, for the read-only chip preview. */
  readonly fetchDraftImage: (imageId: string) => Promise<Blob>
  /** One-shot backfill (rewind text / side-task quote) owned by the session page. */
  readonly prefill?: ComposerPrefill | undefined
  /** Read-only `@` / `#` completion against this session's workspace. */
  readonly searchPromptRefs: (
    trigger: MobilePromptRefTrigger,
    query: string,
  ) => Promise<readonly MobilePromptRefSuggestion[]>
  /** Second step for `commit` / `chatContext` entries; `chatContext` may open a PC picker. */
  readonly resolvePromptRef: (
    kind: MobilePromptRefResolveKind,
    query: string,
    options?: { readonly handle?: number; readonly label?: string; readonly limit?: number },
  ) => Promise<ResolvePromptRefResult>
  /** Latest draft from the hub (PC or another phone), applied when this phone is idle. */
  readonly draft?: MobileDraftState | undefined
  /** Gateway ack for this phone's latest draft; advances the local revision watermark. */
  readonly draftAck?: { readonly clientUpdateId: string; readonly revision: number } | undefined
  readonly onDraftChange: (
    text: string,
    images: readonly MobileDraftImageRef[],
    files: readonly MobileDraftFileRef[],
  ) => string | undefined
  readonly onSend: (
    text: string,
    attachmentIds: readonly string[],
    draftImageIds: readonly string[],
    draftFileIds: readonly string[],
    refs: readonly MobilePromptRef[],
  ) => Promise<void>
  readonly onStop: () => Promise<void>
  readonly onNotice: (text: string) => void
}

export function Composer({
  sessionKey,
  readOnly,
  running,
  online,
  imageSupported,
  fileSupported,
  commands,
  onUploadAttachment,
  fetchDraftImage,
  prefill,
  searchPromptRefs,
  resolvePromptRef,
  draft,
  draftAck,
  onDraftChange,
  onSend,
  onStop,
  onNotice,
}: ComposerProps) {
  const [initialDraft] = useState(() => readDraft(sessionKey))
  const [value, setValue] = useState(initialDraft.text)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([])
  const [placedRefs, setPlacedRefs] = useState<readonly PlacedPromptRef[]>(() =>
    (initialDraft.refs ?? []).map((ref) => ({ ref, start: ref.start, end: ref.end })),
  )
  const [removedDraftImages, setRemovedDraftImages] = useState<ReadonlySet<string>>(new Set())
  const [removedDraftFiles, setRemovedDraftFiles] = useState<ReadonlySet<string>>(new Set())
  const [caret, setCaret] = useState(initialDraft.caret)
  const [armed, setArmed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [refDismissed, setRefDismissed] = useState(false)
  const [refIndex, setRefIndex] = useState(0)
  const [refSuggestions, setRefSuggestions] =
    useState<readonly MobilePromptRefSuggestion[]>(EMPTY_PROMPT_REFS)
  const [refLoading, setRefLoading] = useState(false)
  const [refFailed, setRefFailed] = useState(false)
  const [secondStep, setSecondStep] = useState<PromptRefSecondStep | undefined>(undefined)
  const [secondIndex, setSecondIndex] = useState(0)
  const [caretRequest, setCaretRequest] = useState(0)
  const pendingCaret = useRef<number | null>(null)
  const refSearchSeq = useRef(0)
  const secondStepSeq = useRef(0)
  const disabled = !online || readOnly
  const textareaRef = useAutoGrowTextarea(value, { maxHeightPx: MAX_HEIGHT_PX })
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentSeq = useRef(0)
  const previewUrls = useRef<Set<string>>(new Set())
  const mounted = useRef(true)
  const composing = useRef(false)
  /** Highest gateway revision this composer has applied or been acked for. */
  const lastIncorporatedRevision = useRef(0)
  /** Local publishes in flight, by the id the gateway will echo back. */
  const pendingSends = useRef<Set<string>>(new Set())
  /** Local field snapshot considered already published (see localDraftKey). */
  const lastPublishedKey = useRef(
    localDraftKey(initialDraft.text, [], [], EMPTY_ID_SET, EMPTY_ID_SET),
  )
  /** Selection to restore after a remote value commit; never the remote caret. */
  const pendingSelection = useRef<{ start: number; end: number } | undefined>(undefined)
  const interacted = useRef(false)
  /** sessionStorage had text at mount; publish it once the gateway is reachable. */
  const restoredDraft = useRef(initialDraft.text !== '')
  const [syncTick, setSyncTick] = useState(0)
  /** Retry signal for a completion query suppressed by IME composition. */
  const [refSearchTick, setRefSearchTick] = useState(0)
  const onDraftChangeRef = useRef(onDraftChange)
  const searchPromptRefsRef = useRef(searchPromptRefs)
  const resolvePromptRefRef = useRef(resolvePromptRef)

  // Bumping the sequence invalidates a pending second-step RPC: its late
  // result (commit list or the extension picker's answer) must not insert into
  // text the user has since edited or replaced.
  const closeSecondStep = useCallback((): void => {
    secondStepSeq.current += 1
    setSecondStep(undefined)
    setSecondIndex(0)
  }, [])

  useEffect(() => {
    const urls = previewUrls.current
    mounted.current = true
    return () => {
      mounted.current = false
      secondStepSeq.current += 1
      releaseAllPreviewUrls(urls)
    }
  }, [])

  useEffect(() => {
    writeDraft(sessionKey, value, caret, Date.now(), collectPlacedRefs(value, placedRefs))
  }, [sessionKey, value, caret, placedRefs])

  useEffect(() => {
    if (prefill === undefined || prefill.sessionKey !== sessionKey) return
    interacted.current = true
    closeSecondStep()
    setRefDismissed(false)
    setValue(prefill.text)
    setPlacedRefs([])
    textareaRef.current?.focus()
  }, [prefill, sessionKey, textareaRef, closeSecondStep])

  const slash: SlashQuery | null = armed && !disabled ? extractSlashQuery(value, caret) : null
  const slashMatches = slash === null ? NO_COMMANDS : filterSlashCommands(commands, slash.query)
  const slashOpen = focused && !slashDismissed && slash !== null && slashMatches.length > 0
  const activeSlashIndex = Math.min(slashIndex, Math.max(slashMatches.length - 1, 0))
  const slashQuery = slash?.query

  // One panel at a time: `/` owns the first token, `#` wins over `@` because a
  // single token can only carry one prefix (same precedence as the desktop).
  const refQuery: PromptRefQuery | null =
    armed && !disabled && slash === null
      ? (extractHashQuery(value, caret) ?? extractMentionQuery(value, caret))
      : null
  const refOpen = focused && !refDismissed && refQuery !== null
  const activeRefIndex = Math.min(refIndex, Math.max(refSuggestions.length - 1, 0))
  const secondSuggestions = secondStep?.suggestions ?? EMPTY_PROMPT_REFS
  const activeSecondIndex = Math.min(secondIndex, Math.max(secondSuggestions.length - 1, 0))
  const refTrigger = refQuery?.trigger
  const refQueryText = refQuery?.query

  // A dismissed list re-arms itself once the command token disappears, so
  // backspacing into the token brings the suggestions back.
  const slashActive = slash !== null
  useEffect(() => {
    if (!slashActive) setSlashDismissed(false)
  }, [slashActive])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery])

  const refActive = refQuery !== null
  useEffect(() => {
    if (!refActive) setRefDismissed(false)
  }, [refActive])

  useEffect(() => {
    setRefIndex(0)
  }, [refTrigger, refQueryText])

  // Debounced completion query. `refSearchSeq` discards a slow response that a
  // newer query, a dismissed panel or an IME composition has superseded. Draft
  // acks bump `syncTick` but must not re-run this effect; only composition end
  // bumps `refSearchTick` to retry a query suppressed during composition.
  useEffect(() => {
    const seq = ++refSearchSeq.current
    if (
      !refOpen ||
      secondStep !== undefined ||
      refTrigger === undefined ||
      refQueryText === undefined ||
      composing.current
    ) {
      setRefLoading(false)
      return
    }
    setRefSuggestions(EMPTY_PROMPT_REFS)
    setRefFailed(false)
    setRefLoading(true)
    const timer = window.setTimeout(() => {
      void searchPromptRefsRef
        .current(refTrigger, refQueryText)
        .then((entries) => {
          if (seq !== refSearchSeq.current) return
          setRefSuggestions(entries)
        })
        .catch(() => {
          if (seq !== refSearchSeq.current) return
          setRefFailed(true)
        })
        .finally(() => {
          if (seq === refSearchSeq.current) setRefLoading(false)
        })
    }, REF_SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [refOpen, secondStep, refTrigger, refQueryText, refSearchTick])

  useLayoutEffect(() => {
    const position = pendingCaret.current
    if (position === null) return
    pendingCaret.current = null
    const element = textareaRef.current
    if (element === null) return
    element.focus({ preventScroll: true })
    element.setSelectionRange(position, position)
  }, [caretRequest, textareaRef])

  const attaching = attachments.some((attachment) => attachment.status === 'uploading')
  const canAttach = (imageSupported || fileSupported) && !disabled
  const readyAttachments = attachments.filter(
    (attachment) => attachment.status === 'uploaded' && attachment.id !== undefined,
  )
  const localImages = useMemo<MobileDraftImageRef[]>(
    () =>
      attachments
        .filter(
          (attachment) =>
            attachment.status === 'uploaded' &&
            attachment.id !== undefined &&
            attachment.kind === 'image',
        )
        .map((attachment) => ({
          id: attachment.id as string,
          source: 'mobile',
          mimeType: attachment.mimeType,
          byteSize: attachment.size,
          name: attachment.name,
        })),
    [attachments],
  )
  const localImageIds = useMemo(() => new Set(localImages.map((image) => image.id)), [localImages])
  // Pictures from the PC or another phone stay in the hub draft; this phone
  // echoes their refs so a later edit does not delete them, and sends their ids
  // on submit. Its own uploads are represented by the attachment chips instead.
  const remoteDraftImages = useMemo(
    () =>
      (draft?.images ?? []).filter(
        (image) => !removedDraftImages.has(image.id) && !localImageIds.has(image.id),
      ),
    [draft, removedDraftImages, localImageIds],
  )
  const localFiles = useMemo<MobileDraftFileRef[]>(
    () =>
      attachments
        .filter(
          (attachment) =>
            attachment.status === 'uploaded' &&
            attachment.id !== undefined &&
            attachment.kind === 'file',
        )
        .map((attachment) => ({
          id: attachment.id as string,
          name: attachment.name,
          ...(attachment.mimeType !== '' ? { mimeType: attachment.mimeType } : {}),
          byteSize: attachment.size,
        })),
    [attachments],
  )
  const localFileIds = useMemo(() => new Set(localFiles.map((file) => file.id)), [localFiles])
  const remoteDraftFiles = useMemo(
    () =>
      (draft?.files ?? []).filter(
        (file) => !removedDraftFiles.has(file.id) && !localFileIds.has(file.id),
      ),
    [draft, removedDraftFiles, localFileIds],
  )
  const draftImageIds = useMemo(
    () => remoteDraftImages.map((image) => image.id),
    [remoteDraftImages],
  )
  const draftFileIds = useMemo(() => remoteDraftFiles.map((file) => file.id), [remoteDraftFiles])

  // Read by the debounce timers below: they must see the latest local/remote
  // inputs without depending on remote drafts (which would cancel a PC edit).
  const snapshotRef = useRef({
    value: initialDraft.text,
    localImages: [] as readonly MobileDraftImageRef[],
    localFiles: [] as readonly MobileDraftFileRef[],
    remoteDraftImages: [] as readonly MobileDraftImageRef[],
    remoteDraftFiles: [] as readonly MobileDraftFileRef[],
    removedImages: EMPTY_ID_SET,
    removedFiles: EMPTY_ID_SET,
    key: localDraftKey(initialDraft.text, [], [], EMPTY_ID_SET, EMPTY_ID_SET),
  })
  const draftRef = useRef(draft)
  useLayoutEffect(() => {
    snapshotRef.current = {
      value,
      localImages,
      localFiles,
      remoteDraftImages,
      remoteDraftFiles,
      removedImages: removedDraftImages,
      removedFiles: removedDraftFiles,
      key: localDraftKey(value, localImages, localFiles, removedDraftImages, removedDraftFiles),
    }
    draftRef.current = draft
    onDraftChangeRef.current = onDraftChange
    searchPromptRefsRef.current = searchPromptRefs
    resolvePromptRefRef.current = resolvePromptRef
  })

  const publishDraft = useCallback((force = false): boolean => {
    const snapshot = snapshotRef.current
    if (!mounted.current || composing.current) return false
    if (!force && snapshot.key === lastPublishedKey.current) return false
    const clientUpdateId = onDraftChangeRef.current(
      snapshot.value,
      [...snapshot.remoteDraftImages, ...snapshot.localImages],
      [...snapshot.remoteDraftFiles, ...snapshot.localFiles],
    )
    if (clientUpdateId === undefined) return false
    pendingSends.current.add(clientUpdateId)
    lastPublishedKey.current = snapshot.key
    return true
  }, [])

  const applyRemoteDraft = useCallback(
    (next: MobileDraftState): void => {
      const oldText = snapshotRef.current.value
      if (next.text !== oldText) {
        const element = textareaRef.current
        const max = next.text.length
        // Keep this phone's selection; the remote caret no longer exists on the wire.
        const keepSelection = oldText !== '' && document.activeElement === element
        const start = keepSelection ? Math.min(element?.selectionStart ?? max, max) : max
        const end = keepSelection ? Math.min(element?.selectionEnd ?? start, max) : max
        pendingSelection.current = { start, end }
        setValue(next.text)
        setCaret(start)
        // Remote text has no tracked ranges here; stale refs would fail the
        // send-time slice check, so drop them instead of sending a broken prompt.
        setPlacedRefs([])
        closeSecondStep()
      }
      lastIncorporatedRevision.current = Math.max(lastIncorporatedRevision.current, next.revision)
      // Adopt the applied text as the published baseline: it must not bounce
      // back to the gateway as a local edit.
      const nextKey = localDraftKey(
        next.text,
        snapshotRef.current.localImages,
        snapshotRef.current.localFiles,
        snapshotRef.current.removedImages,
        snapshotRef.current.removedFiles,
      )
      lastPublishedKey.current = nextKey
      snapshotRef.current = { ...snapshotRef.current, value: next.text, key: nextKey }
    },
    [textareaRef, closeSecondStep],
  )

  // The controlled textarea moves its caret to the end when React commits a new
  // value; restore the local selection after the commit, never inside setValue.
  useLayoutEffect(() => {
    const selection = pendingSelection.current
    if (selection === undefined) return
    pendingSelection.current = undefined
    const element = textareaRef.current
    if (element === null) return
    element.setSelectionRange(selection.start, selection.end)
    setCaret(selection.start)
  }, [value, textareaRef])

  // A dropped connection loses the echo that would settle these ids; the
  // resubscribed snapshot is the new baseline.
  useEffect(() => {
    if (!online) pendingSends.current.clear()
  }, [online])

  // Our own update echoed by the gateway is an ack, never remote text.
  useEffect(() => {
    if (draftAck === undefined) return
    pendingSends.current.delete(draftAck.clientUpdateId)
    lastIncorporatedRevision.current = Math.max(lastIncorporatedRevision.current, draftAck.revision)
    setSyncTick((tick) => tick + 1)
  }, [draftAck])

  // Apply a remote draft only when this phone is not the writer: no IME, no
  // local publish in flight, no unpublished local fields, and a newer revision.
  useEffect(() => {
    if (draft === undefined || disabled) return
    if (draft.revision <= lastIncorporatedRevision.current) return
    if (draftAck !== undefined && draft.revision <= draftAck.revision) return
    if (composing.current || pendingSends.current.size > 0) return
    if (snapshotRef.current.key !== lastPublishedKey.current) return
    applyRemoteDraft(draft)
  }, [
    draft,
    draftAck,
    disabled,
    value,
    attachments,
    removedDraftImages,
    removedDraftFiles,
    syncTick,
    applyRemoteDraft,
  ])

  // Publish local edits after a short pause. Only local fields participate:
  // caret moves and remote attachment mirrors never schedule a publish.
  useEffect(() => {
    if (!interacted.current || disabled) return
    if (snapshotRef.current.key === lastPublishedKey.current) return
    const handle = window.setTimeout(() => publishDraft(), DRAFT_SYNC_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [value, attachments, removedDraftImages, removedDraftFiles, disabled, syncTick, publishDraft])

  // A draft restored from sessionStorage (page reload / app restart) is pushed
  // once the snapshot has been seen and only when the hub has nothing newer.
  useEffect(() => {
    if (!restoredDraft.current || !online || disabled) return
    restoredDraft.current = false
    if (draft !== undefined) return
    interacted.current = true
    const handle = window.setTimeout(() => {
      if (draftRef.current !== undefined) return
      if (!publishDraft(true)) {
        // The gateway was momentarily unwritable; make the normal debounce
        // retry instead of losing the restored draft.
        lastPublishedKey.current = ''
        setSyncTick((tick) => tick + 1)
      }
    }, DRAFT_SYNC_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [online, disabled, draft, publishDraft])

  const canSend =
    !disabled &&
    !sending &&
    !stopping &&
    !attaching &&
    // The placeholder token (`#Git`) is not a valid prompt on its own.
    secondStep === undefined &&
    attachments.every((attachment) => attachment.status === 'uploaded') &&
    (value.trim() !== '' ||
      readyAttachments.length > 0 ||
      remoteDraftFiles.length > 0 ||
      remoteDraftImages.length > 0)

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value
    interacted.current = true
    if (secondStep !== undefined) closeSecondStep()
    setPlacedRefs((current) => applyTextEdit(value, next, current))
    setValue(next)
    setCaret(event.target.selectionStart ?? next.length)
    setArmed(true)
  }

  const handleCompositionStart = (): void => {
    composing.current = true
    // Invalidate any completion query already in flight: it was computed for
    // the pre-composition text and must not overwrite the panel mid-IME.
    refSearchSeq.current++
    if (secondStep !== undefined) closeSecondStep()
  }

  const handleCompositionEnd = (): void => {
    composing.current = false
    // Re-evaluate both directions: apply what arrived during the IME session,
    // or publish the text the IME just committed.
    setSyncTick((tick) => tick + 1)
    setRefSearchTick((tick) => tick + 1)
  }

  const acceptCommand = (command: MobileAvailableCommand): void => {
    if (slash === null) return
    const next = applySlashCommand(value, slash.tokenEnd, command.name)
    if (next.text.length > MAX_PROMPT_LENGTH) return
    interacted.current = true
    pendingCaret.current = next.caret
    setCaretRequest((request) => request + 1)
    setValue(next.text)
    setCaret(next.caret)
    setSlashDismissed(true)
  }

  // Reopening the first list keeps a cancelled picker retryable: the `#` token
  // is still under the caret, so dismissing the panel would strand the user.
  const reopenFirstStep = (): void => {
    closeSecondStep()
    setRefDismissed(false)
  }

  const leaveSecondStep = (): void => {
    // A PC picker may still be open for chatContext; its late answer is
    // discarded by the sequence bump. Escape returns to the first list rather
    // than dismissing the whole panel.
    reopenFirstStep()
    textareaRef.current?.focus()
  }

  const insertRefAtAnchor = (
    anchor: PromptRefAnchor,
    suggestion: MobilePromptRefSuggestion,
  ): boolean => {
    const base = snapshotRef.current.value
    // Edits close the second step, but re-check anyway: a slice mismatch would
    // insert a ref whose token no longer exists.
    if (base.slice(anchor.start, anchor.end) !== anchor.anchorText) return false
    const next = insertPromptRef(base, anchor.start, anchor.end, suggestion)
    if (next.text.length > MAX_PROMPT_LENGTH) return false
    interacted.current = true
    setPlacedRefs((current) =>
      [...applyTextEdit(base, next.text, current), next.placed].sort(
        (left, right) => left.start - right.start,
      ),
    )
    pendingCaret.current = next.caret
    setCaretRequest((request) => request + 1)
    setValue(next.text)
    setCaret(next.caret)
    setRefDismissed(true)
    closeSecondStep()
    return true
  }

  const failSecondStep = (seq: number): void => {
    if (seq !== secondStepSeq.current) return
    setSecondStep((current) =>
      current === undefined ? current : { ...current, loading: false, failed: true },
    )
  }

  const beginSecondStep = (suggestion: MobilePromptRefSuggestion, query: PromptRefQuery): void => {
    if (suggestion.kind !== 'commit' && suggestion.kind !== 'chatContext') return
    if (suggestion.kind === 'chatContext' && suggestion.chatContextHandle === undefined) return
    const anchor: PromptRefAnchor = {
      start: query.start,
      end: query.end,
      anchorText: value.slice(query.start, query.end),
    }
    const seq = ++secondStepSeq.current
    setRefDismissed(true)
    setSecondIndex(0)

    if (suggestion.kind === 'commit') {
      setSecondStep({
        kind: 'commit',
        title: strings.promptRefPickCommit,
        anchor,
        suggestions: EMPTY_PROMPT_REFS,
        loading: true,
        failed: false,
        emptyText: strings.promptRefCommitEmpty,
      })
      void resolvePromptRefRef
        .current('commit', query.query)
        .then((result: ResolvePromptRefResult) => {
          if (seq !== secondStepSeq.current) return
          if (result.kind !== 'commit') {
            failSecondStep(seq)
            return
          }
          setSecondStep((current) =>
            current === undefined || current.kind !== 'commit'
              ? current
              : { ...current, loading: false, suggestions: result.entries },
          )
        })
        .catch(() => failSecondStep(seq))
      return
    }

    const handle = suggestion.chatContextHandle
    if (handle === undefined) return
    setSecondStep({
      kind: 'chatContext',
      title: suggestion.label,
      anchor,
      suggestions: EMPTY_PROMPT_REFS,
      loading: true,
      failed: false,
      loadingText: strings.promptRefWaitForPc,
    })
    void resolvePromptRefRef
      .current('chatContext', query.query, { handle, label: suggestion.label })
      .then((result: ResolvePromptRefResult) => {
        if (seq !== secondStepSeq.current) return
        const entry = result.kind === 'chatContext' ? result.entry : undefined
        // No entry means the user cancelled on the PC or the extension is
        // gone; the `#` token stays as typed and the first list reopens so a
        // retry does not require retyping the token.
        if (entry === undefined || !insertRefAtAnchor(anchor, entry)) reopenFirstStep()
      })
      .catch(() => failSecondStep(seq))
  }

  const acceptPromptRef = (suggestion: MobilePromptRefSuggestion): void => {
    const query = refQuery
    if (query === null) return
    if (suggestion.kind === 'commit' || suggestion.kind === 'chatContext') {
      beginSecondStep(suggestion, query)
      return
    }
    const next = insertPromptRef(value, query.start, query.end, suggestion)
    if (next.text.length > MAX_PROMPT_LENGTH) return
    interacted.current = true
    const shifted = applyTextEdit(value, next.text, placedRefs)
    setPlacedRefs([...shifted, next.placed].sort((left, right) => left.start - right.start))
    pendingCaret.current = next.caret
    setCaretRequest((request) => request + 1)
    setValue(next.text)
    setCaret(next.caret)
    setRefDismissed(true)
  }

  const acceptSecondSuggestion = (suggestion: MobilePromptRefSuggestion): void => {
    if (secondStep === undefined) return
    if (!insertRefAtAnchor(secondStep.anchor, suggestion)) reopenFirstStep()
  }

  const insertSlash = (): void => {
    if (disabled || value !== '') return
    interacted.current = true
    pendingCaret.current = 1
    setCaretRequest((request) => request + 1)
    setValue('/')
    setCaret(1)
    setArmed(true)
    setFocused(true)
    setSlashDismissed(false)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (secondStep !== undefined) {
      // The second step owns Enter: swallowing it while the list is loading or
      // empty keeps a newline from silently cancelling the picker.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const suggestion = secondSuggestions[activeSecondIndex]
        if (suggestion !== undefined) acceptSecondSuggestion(suggestion)
        return
      }
      if (secondSuggestions.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSecondIndex((activeSecondIndex + 1) % secondSuggestions.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSecondIndex(
            (activeSecondIndex - 1 + secondSuggestions.length) % secondSuggestions.length,
          )
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        leaveSecondStep()
      }
      return
    }
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashIndex((activeSlashIndex + 1) % slashMatches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashIndex((activeSlashIndex - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const command = slashMatches[activeSlashIndex]
        if (command !== undefined) acceptCommand(command)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissed(true)
      }
      return
    }
    if (!refOpen) return
    if (refSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setRefIndex((activeRefIndex + 1) % refSuggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setRefIndex((activeRefIndex - 1 + refSuggestions.length) % refSuggestions.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const suggestion = refSuggestions[activeRefIndex]
        if (suggestion !== undefined) acceptPromptRef(suggestion)
        return
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setRefDismissed(true)
    }
  }

  const handleFocus = (): void => setFocused(true)

  // A click on a suggestion blurs the textarea before the click lands; keep the
  // list mounted until the next turn and only then decide it really lost focus.
  const handleBlur = (): void => {
    window.setTimeout(() => {
      if (document.activeElement === textareaRef.current) return
      setFocused(false)
      // Keep only an in-flight PC picker (its answer inserts automatically).
      // A commit list or a failed step must not linger off-focus and keep the
      // send button disabled.
      if (secondStep !== undefined && !(secondStep.kind === 'chatContext' && secondStep.loading)) {
        closeSecondStep()
      }
    }, 0)
  }

  const send = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    try {
      await onSend(
        value,
        readyAttachments.map((attachment) => attachment.id as string),
        draftImageIds,
        draftFileIds,
        collectPlacedRefs(value, placedRefs),
      )
      setValue('')
      setPlacedRefs([])
      releaseAllPreviewUrls(previewUrls.current)
      setAttachments([])
      setRemovedDraftImages(new Set())
      setRemovedDraftFiles(new Set())
      pendingSends.current.clear()
      lastPublishedKey.current = localDraftKey('', [], [], EMPTY_ID_SET, EMPTY_ID_SET)
      clearDraft(sessionKey)
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
    } finally {
      setSending(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!online || readOnly || stopping) return
    setStopping(true)
    try {
      await onStop()
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
    } finally {
      setStopping(false)
    }
  }

  const pick = (): void => {
    attachmentInputRef.current?.click()
  }

  const acceptFiles = (files: readonly File[]): void => {
    if (files.length === 0) return
    if (disabled || attaching) return
    let count = attachments.length
    let imageCount = attachments.filter((attachment) => attachment.kind === 'image').length
    let totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
    const accepted: Array<{ readonly file: File; readonly kind: MobileAttachmentKind }> = []
    for (const file of files) {
      // The system picker mixes photos and documents, so the kind follows the
      // file itself; an agent without image support gets photos as plain files.
      const kind: MobileAttachmentKind =
        imageSupported && isMobileImageMimeType(file.type) ? 'image' : 'file'
      if (count >= MAX_ATTACHMENTS_PER_PROMPT) {
        onNotice(strings.attachmentTooMany)
        break
      }
      if (kind === 'file' && !fileSupported) {
        onNotice(strings.attachmentUnsupportedImage)
        continue
      }
      if (kind === 'image') {
        if (imageCount >= MAX_IMAGE_ATTACHMENTS_PER_PROMPT) {
          onNotice(strings.attachmentTooManyImages)
          continue
        }
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
          onNotice(strings.attachmentImageTooLarge)
          continue
        }
      } else if (file.size > MAX_FILE_ATTACHMENT_BYTES) {
        onNotice(strings.attachmentFileTooLarge)
        continue
      }
      if (totalBytes + file.size > MAX_ATTACHMENT_BYTES_PER_PROMPT) {
        onNotice(strings.attachmentTotalTooLarge)
        continue
      }
      accepted.push({ file, kind })
      count += 1
      totalBytes += file.size
      if (kind === 'image') imageCount += 1
    }
    if (accepted.length === 0) return

    const pending = accepted.map(({ file, kind }): ComposerAttachment => {
      attachmentSeq.current += 1
      const previewUrl =
        kind === 'image' ? rememberPreviewUrl(previewUrls.current, file) : undefined
      return {
        key: `a${attachmentSeq.current}`,
        kind,
        name: file.name.trim() === '' ? 'attachment' : file.name,
        size: file.size,
        status: 'uploading',
        mimeType: file.type.trim(),
        ...(previewUrl === undefined ? {} : { previewUrl }),
      }
    })
    setAttachments((current) => [...current, ...pending])
    void uploadAll(accepted, pending)
  }

  const pickFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget
    // Clearing the input mutates the live FileList, so snapshot it first.
    const files = Array.from(input.files ?? [])
    input.value = ''
    acceptFiles(files)
  }

  const uploadAll = async (
    accepted: ReadonlyArray<{ readonly file: File; readonly kind: MobileAttachmentKind }>,
    pending: readonly ComposerAttachment[],
  ): Promise<void> => {
    for (let index = 0; index < accepted.length; index += 1) {
      const entry = accepted[index]
      const chip = pending[index]
      if (entry === undefined || chip === undefined) continue
      try {
        const result = await onUploadAttachment(entry.file, entry.kind)
        if (!mounted.current) return
        interacted.current = true
        setAttachments((current) =>
          current.map((attachment) =>
            attachment.key === chip.key
              ? {
                  ...attachment,
                  status: 'uploaded',
                  id: result.id,
                  name: result.name,
                  size: result.size,
                  ...(result.mimeType !== undefined ? { mimeType: result.mimeType } : {}),
                }
              : attachment,
          ),
        )
      } catch (error) {
        if (!mounted.current) return
        setAttachments((current) =>
          current.map((attachment) =>
            attachment.key === chip.key ? { ...attachment, status: 'failed' } : attachment,
          ),
        )
        onNotice(commandErrorText(errorCode(error)))
      }
    }
  }

  const removeAttachment = (key: string): void => {
    if (sending) return
    const removed = attachments.find((attachment) => attachment.key === key)
    if (removed?.previewUrl !== undefined) {
      releasePreviewUrl(previewUrls.current, removed.previewUrl)
    }
    interacted.current = true
    setAttachments((current) => current.filter((attachment) => attachment.key !== key))
  }

  return (
    <div className="composer" data-testid="composer">
      {disabled && (
        <p className={`composer__hint${online ? '' : ' composer__hint--danger'}`}>
          {online ? strings.composerReadOnly : strings.composerOffline}
        </p>
      )}
      {!disabled && running && <p className="composer__hint">{strings.composerStopHint}</p>}
      {remoteDraftImages.length > 0 && (
        <DraftImageChips
          images={remoteDraftImages}
          fetchImage={fetchDraftImage}
          onRemove={(id) => {
            interacted.current = true
            setRemovedDraftImages((current) => new Set(current).add(id))
          }}
        />
      )}
      {((draft?.refs?.length ?? 0) > 0 || (draft?.contexts?.length ?? 0) > 0) && (
        <div className="composer__attachments" data-testid="composer-draft-refs">
          {draft?.refs?.map((ref) => (
            <span key={ref.id} className="composer__chip">
              <span className="composer__chip-name">
                {ref.kind === 'file' ? '@' : '#'}
                {ref.label}
              </span>
            </span>
          ))}
          {draft?.contexts?.map((context) => (
            <span key={`${context.relPath}:${context.startLine}`} className="composer__chip">
              <span className="composer__chip-name">
                {context.relPath}:{context.startLine}
                {context.endLine !== context.startLine ? `-${context.endLine}` : ''}
              </span>
            </span>
          ))}
        </div>
      )}
      {remoteDraftFiles.length > 0 && (
        <div className="composer__attachments" data-testid="composer-draft-files">
          {remoteDraftFiles.map((file) => (
            <div key={file.id} className="composer__chip" data-testid="composer-draft-file">
              <span className="composer__chip-name">{file.name}</span>
              <span className="composer__chip-size">{formatAttachmentSize(file.byteSize)}</span>
              <button
                type="button"
                className="composer__chip-remove"
                aria-label={strings.attachmentRemove}
                onClick={() => {
                  interacted.current = true
                  setRemovedDraftFiles((current) => new Set(current).add(file.id))
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer__attachments" data-testid="composer-attachments">
          {attachments.map((attachment) => (
            <ComposerAttachmentChip
              key={attachment.key}
              attachment={attachment}
              sending={sending}
              onRemove={removeAttachment}
            />
          ))}
        </div>
      )}
      {slashOpen && (
        <SlashCommandPanel
          commands={slashMatches}
          activeIndex={activeSlashIndex}
          onPick={acceptCommand}
        />
      )}
      {secondStep !== undefined && (
        <PromptRefPanel
          trigger={refTrigger ?? '#'}
          suggestions={secondStep.suggestions}
          activeIndex={activeSecondIndex}
          loading={secondStep.loading}
          failed={secondStep.failed}
          onPick={acceptSecondSuggestion}
          title={secondStep.title}
          onBack={leaveSecondStep}
          loadingText={secondStep.loadingText}
          emptyText={secondStep.emptyText}
        />
      )}
      {secondStep === undefined && refOpen && refQuery !== null && (
        <PromptRefPanel
          trigger={refQuery.trigger}
          suggestions={refSuggestions}
          activeIndex={activeRefIndex}
          loading={refLoading}
          failed={refFailed}
          onPick={acceptPromptRef}
        />
      )}
      <div className="composer__row">
        {canAttach && (
          <button
            type="button"
            className="composer__attach"
            data-testid="composer-attach"
            aria-label={strings.composerAttach}
            disabled={sending || stopping || attaching}
            onClick={pick}
          >
            +
          </button>
        )}
        {commands.length > 0 && value === '' && !disabled && (
          <button
            type="button"
            className="composer__slash"
            data-testid="composer-slash"
            aria-label={strings.composerCommands}
            onClick={insertSlash}
          >
            /
          </button>
        )}
        <textarea
          ref={textareaRef}
          className="composer__input"
          data-testid="composer-input"
          rows={1}
          value={value}
          disabled={disabled}
          maxLength={MAX_PROMPT_LENGTH}
          placeholder={
            online
              ? commands.length > 0
                ? strings.composerPlaceholderWithCommands
                : strings.composerPlaceholder
              : strings.composerOffline
          }
          aria-label={strings.composerPlaceholder}
          aria-autocomplete="list"
          aria-controls={
            slashOpen
              ? SLASH_COMMAND_LIST_ID
              : secondStep !== undefined || refOpen
                ? PROMPT_REF_LIST_ID
                : undefined
          }
          aria-expanded={slashOpen || refOpen || secondStep !== undefined}
          aria-activedescendant={
            slashOpen
              ? slashCommandOptionId(activeSlashIndex)
              : secondStep !== undefined && secondSuggestions.length > 0
                ? promptRefOptionId(activeSecondIndex)
                : refOpen && refSuggestions.length > 0
                  ? promptRefOptionId(activeRefIndex)
                  : undefined
          }
          onChange={handleChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        {running && (
          <button
            type="button"
            className="composer__stop"
            data-testid="composer-stop"
            aria-label={strings.composerStop}
            disabled={disabled || stopping || sending}
            onClick={() => void stop()}
          >
            {stopping ? strings.composerStopping : strings.composerStop}
          </button>
        )}
        {(value.trim() !== '' || attachments.length > 0) && (
          <button
            type="button"
            className="composer__send"
            data-testid="composer-send"
            aria-label={strings.composerSend}
            disabled={!canSend}
            onClick={() => void send()}
          >
            {sending ? strings.composerSending : strings.composerSend}
          </button>
        )}
      </div>
      {canAttach && (
        <input
          ref={attachmentInputRef}
          className="composer__file-input"
          data-testid="composer-attachment-input"
          type="file"
          // No accept when files are allowed: iOS then offers photo library,
          // camera and files in one system sheet instead of a nested menu.
          accept={fileSupported ? undefined : 'image/*'}
          multiple
          onChange={pickFiles}
        />
      )}
    </div>
  )
}

function DraftImageChips({
  images,
  fetchImage,
  onRemove,
}: {
  images: readonly MobileDraftImageRef[]
  fetchImage: (imageId: string) => Promise<Blob>
  onRemove: (id: string) => void
}) {
  const [preview, setPreview] = useState<{ src: string; alt: string } | undefined>(undefined)
  const [loading, setLoading] = useState<string | undefined>(undefined)
  const objectUrl = useRef<string | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    return () => {
      mounted.current = false
      if (objectUrl.current !== undefined) URL.revokeObjectURL(objectUrl.current)
    }
  }, [])

  const open = async (image: MobileDraftImageRef): Promise<void> => {
    if (loading !== undefined) return
    setLoading(image.id)
    try {
      const blob = await fetchImage(image.id)
      if (!mounted.current) return
      if (objectUrl.current !== undefined) URL.revokeObjectURL(objectUrl.current)
      const src = URL.createObjectURL(blob)
      objectUrl.current = src
      setPreview({ src, alt: strings.messageImageAlt })
    } catch {
      // A deleted/expired draft picture simply does not preview.
    } finally {
      setLoading(undefined)
    }
  }

  return (
    <>
      <div className="composer__attachments" data-testid="composer-draft-images">
        {images.map((image) => (
          <div key={image.id} className="composer__chip" data-testid="composer-draft-image">
            <button
              type="button"
              className="composer__chip-name"
              aria-label={strings.draftImageOpen}
              disabled={loading === image.id}
              onClick={() => void open(image)}
            >
              {image.name ?? strings.draftImageFallbackName}
            </button>
            <span className="composer__chip-size">{formatAttachmentSize(image.byteSize)}</span>
            <button
              type="button"
              className="composer__chip-remove"
              aria-label={strings.draftImageRemove}
              onClick={() => onRemove(image.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {preview !== undefined && (
        <ImagePreviewOverlay
          src={preview.src}
          alt={preview.alt}
          onClose={() => setPreview(undefined)}
        />
      )}
    </>
  )
}

export function draftKey(sessionKey: string): string {
  return `${DRAFT_PREFIX}${sessionKey}`
}

export function legacyDraftKey(sessionKey: string): string {
  return `${LEGACY_DRAFT_PREFIX}${sessionKey}`
}

export interface StoredDraft {
  readonly text: string
  readonly caret: number
  /** Structured `@` / `#` refs, kept only while their token slices still match. */
  readonly refs?: readonly MobilePromptRef[]
}

export function readDraft(sessionKey: string): StoredDraft {
  try {
    const raw = globalThis.sessionStorage?.getItem(draftKey(sessionKey))
    if (raw !== null && raw !== undefined) {
      // A corrupt v2 payload must not be pasted into the input box.
      return parseStoredDraft(raw) ?? { text: '', caret: 0 }
    }
    const legacy = globalThis.sessionStorage?.getItem(legacyDraftKey(sessionKey)) ?? ''
    return { text: legacy, caret: legacy.length }
  } catch {
    return { text: '', caret: 0 }
  }
}

export function writeDraft(
  sessionKey: string,
  value: string,
  caret: number = value.length,
  now: number = Date.now(),
  refs: readonly MobilePromptRef[] = [],
): void {
  try {
    const storage = globalThis.sessionStorage
    if (value === '') {
      storage?.removeItem(draftKey(sessionKey))
    } else {
      storage?.setItem(
        draftKey(sessionKey),
        JSON.stringify({
          text: value,
          caret,
          updatedAt: now,
          ...(refs.length > 0 ? { refs } : {}),
        }),
      )
      pruneDrafts(draftKey(sessionKey), storage)
    }
    storage?.removeItem(legacyDraftKey(sessionKey))
  } catch {
    // Storage can be unavailable (private mode); the draft is a convenience only.
  }
}

export function clearDraft(sessionKey: string): void {
  writeDraft(sessionKey, '')
}

function rememberPreviewUrl(urls: Set<string>, file: File): string {
  const url = URL.createObjectURL(file)
  urls.add(url)
  return url
}

function releasePreviewUrl(urls: Set<string>, url: string): void {
  urls.delete(url)
  URL.revokeObjectURL(url)
}

function releaseAllPreviewUrls(urls: Set<string>): void {
  for (const url of urls) URL.revokeObjectURL(url)
  urls.clear()
}

function parseStoredDraft(raw: string): StoredDraft | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { text?: unknown; caret?: unknown; refs?: unknown }
    if (typeof record.text !== 'string' || typeof record.caret !== 'number') return undefined
    const refs = Array.isArray(record.refs)
      ? collectPlacedRefs(
          record.text,
          record.refs
            .filter(isStoredPromptRef)
            .map((ref) => ({ ref, start: ref.start, end: ref.end })),
        )
      : []
    return { text: record.text, caret: record.caret, ...(refs.length > 0 ? { refs } : {}) }
  } catch {
    return undefined
  }
}

function isStoredPromptRef(value: unknown): value is MobilePromptRef {
  return isSendableMobilePromptRef(value)
}

function pruneDrafts(keep: string, storage: Storage | undefined): void {
  if (storage === undefined) return
  const entries: { key: string; updatedAt: number }[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key === null || !key.startsWith(DRAFT_PREFIX) || key === keep) continue
    entries.push({ key, updatedAt: storedUpdatedAt(storage.getItem(key)) })
  }
  if (entries.length + 1 <= MAX_STORED_DRAFTS) return
  entries.sort((left, right) => left.updatedAt - right.updatedAt)
  for (const entry of entries.slice(0, entries.length + 1 - MAX_STORED_DRAFTS)) {
    storage.removeItem(entry.key)
  }
}

function storedUpdatedAt(raw: string | null): number {
  if (raw === null) return Number.NEGATIVE_INFINITY
  try {
    const parsed: unknown = JSON.parse(raw)
    const updatedAt =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { updatedAt?: unknown }).updatedAt
        : undefined
    return typeof updatedAt === 'number' ? updatedAt : Number.NEGATIVE_INFINITY
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}
