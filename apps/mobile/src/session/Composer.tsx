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
import { ImagePreviewOverlay } from '../components/ImagePreviewOverlay.js'
import { commandErrorText, formatAttachmentSize, strings } from '../strings.js'
import { ComposerAttachmentChip } from './ComposerAttachmentChip.js'
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
/** How long a local keystroke wins over an incoming remote draft. */
const LOCAL_EDIT_GRACE_MS = 400
/** Matches the PC-side publisher; keeps typing from flooding the socket. */
const DRAFT_SYNC_DEBOUNCE_MS = 250

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
  /** Latest draft from the hub (PC or another phone), applied when the user is idle. */
  readonly draft?: MobileDraftState | undefined
  readonly onDraftChange: (
    text: string,
    caret: number,
    baseRevision: number,
    images: readonly MobileDraftImageRef[],
    files: readonly MobileDraftFileRef[],
  ) => void
  readonly onSend: (
    text: string,
    attachmentIds: readonly string[],
    draftImageIds: readonly string[],
    draftFileIds: readonly string[],
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
  draft,
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
  const [removedDraftImages, setRemovedDraftImages] = useState<ReadonlySet<string>>(new Set())
  const [removedDraftFiles, setRemovedDraftFiles] = useState<ReadonlySet<string>>(new Set())
  const [caret, setCaret] = useState(initialDraft.caret)
  const [armed, setArmed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [caretRequest, setCaretRequest] = useState(0)
  const pendingCaret = useRef<number | null>(null)
  const disabled = !online || readOnly
  const textareaRef = useAutoGrowTextarea(value, { maxHeightPx: MAX_HEIGHT_PX })
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentSeq = useRef(0)
  const previewUrls = useRef<Set<string>>(new Set())
  const mounted = useRef(true)
  const lastLocalEditAt = useRef(Number.NEGATIVE_INFINITY)
  const composing = useRef(false)
  const pendingRemote = useRef<MobileDraftState | undefined>(undefined)
  const pendingRemoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const interacted = useRef(false)
  /** sessionStorage had text at mount; publish it once the gateway is reachable. */
  const restoredDraft = useRef(initialDraft.text !== '')
  const [syncTick, setSyncTick] = useState(0)

  const applyRemoteDraft = useCallback(
    (next: MobileDraftState): void => {
      pendingRemote.current = undefined
      if (pendingRemoteTimer.current !== undefined) {
        clearTimeout(pendingRemoteTimer.current)
        pendingRemoteTimer.current = undefined
      }
      setValue(next.text)
      const position = Math.max(0, Math.min(next.caret, next.text.length))
      setCaret(position)
      const element = textareaRef.current
      if (element !== null && document.activeElement === element) {
        element.setSelectionRange(position, position)
      }
    },
    [textareaRef],
  )

  useEffect(() => {
    const urls = previewUrls.current
    mounted.current = true
    return () => {
      mounted.current = false
      releaseAllPreviewUrls(urls)
      if (pendingRemoteTimer.current !== undefined) clearTimeout(pendingRemoteTimer.current)
    }
  }, [])

  useEffect(() => {
    writeDraft(sessionKey, value, caret)
  }, [sessionKey, value, caret])

  useEffect(() => {
    if (prefill === undefined || prefill.sessionKey !== sessionKey) return
    interacted.current = true
    lastLocalEditAt.current = Date.now()
    setValue(prefill.text)
    textareaRef.current?.focus()
  }, [prefill, sessionKey, textareaRef])

  // Apply a draft authored on the PC (or another phone). Text wins only when
  // this device has been idle for a moment, so a slow socket cannot swallow
  // characters the user is typing right now.
  useEffect(() => {
    if (draft === undefined) {
      pendingRemote.current = undefined
      if (pendingRemoteTimer.current !== undefined) {
        clearTimeout(pendingRemoteTimer.current)
        pendingRemoteTimer.current = undefined
      }
      return
    }
    if (draft.text === value && draft.caret === caret) return
    if (composing.current) {
      pendingRemote.current = draft
      return
    }
    if (Date.now() - lastLocalEditAt.current < LOCAL_EDIT_GRACE_MS) return
    applyRemoteDraft(draft)
  }, [draft, value, caret, applyRemoteDraft, syncTick])

  const slash: SlashQuery | null = armed && !disabled ? extractSlashQuery(value, caret) : null
  const slashMatches = slash === null ? NO_COMMANDS : filterSlashCommands(commands, slash.query)
  const slashOpen = focused && !slashDismissed && slash !== null && slashMatches.length > 0
  const activeSlashIndex = Math.min(slashIndex, Math.max(slashMatches.length - 1, 0))
  const slashQuery = slash?.query

  // A dismissed list re-arms itself once the command token disappears, so
  // backspacing into the token brings the suggestions back.
  const slashActive = slash !== null
  useEffect(() => {
    if (!slashActive) setSlashDismissed(false)
  }, [slashActive])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery])

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
  const draftImages = useMemo(
    () => [...remoteDraftImages, ...localImages],
    [remoteDraftImages, localImages],
  )
  const draftImageIds = useMemo(
    () => remoteDraftImages.map((image) => image.id),
    [remoteDraftImages],
  )
  const draftFiles = useMemo(
    () => [...remoteDraftFiles, ...localFiles],
    [remoteDraftFiles, localFiles],
  )
  const draftFileIds = useMemo(() => remoteDraftFiles.map((file) => file.id), [remoteDraftFiles])
  const canSend =
    !disabled &&
    !sending &&
    !stopping &&
    !attaching &&
    attachments.every((attachment) => attachment.status === 'uploaded') &&
    (value.trim() !== '' ||
      readyAttachments.length > 0 ||
      remoteDraftFiles.length > 0 ||
      remoteDraftImages.length > 0)

  // Publish local edits after a short pause. Nothing is sent on mount: a draft
  // restored from sessionStorage is published by the first real interaction.
  useEffect(() => {
    if (!interacted.current || disabled) return
    const matchesDraft =
      draft !== undefined &&
      draft.text === value &&
      draft.caret === caret &&
      JSON.stringify(draft.images) === JSON.stringify(draftImages) &&
      JSON.stringify(draft.files ?? []) === JSON.stringify(draftFiles)
    if (matchesDraft) return
    const handle = window.setTimeout(() => {
      if (!mounted.current || composing.current) return
      onDraftChange(value, caret, draft?.revision ?? 0, draftImages, draftFiles)
    }, DRAFT_SYNC_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [value, caret, draft, draftImages, draftFiles, disabled, online, onDraftChange, syncTick])

  // A draft restored from sessionStorage (page reload / app restart) is pushed
  // once the snapshot has been seen and only when the hub has nothing newer.
  useEffect(() => {
    if (!restoredDraft.current || !online || disabled) return
    restoredDraft.current = false
    if (draft !== undefined) return
    interacted.current = true
    const handle = window.setTimeout(() => {
      if (!mounted.current || composing.current) return
      onDraftChange(value, caret, 0, draftImages, draftFiles)
    }, DRAFT_SYNC_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [online, disabled, draft, value, caret, draftImages, draftFiles, onDraftChange])

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value
    interacted.current = true
    lastLocalEditAt.current = Date.now()
    setValue(next)
    setCaret(event.target.selectionStart ?? next.length)
    setArmed(true)
  }

  const handleCompositionStart = (): void => {
    composing.current = true
  }

  const handleCompositionEnd = (): void => {
    composing.current = false
    const pending = pendingRemote.current
    if (pending !== undefined) {
      // The last keystroke just happened, so the grace period has not elapsed
      // yet; apply the buffered remote draft as soon as it does.
      const remaining = LOCAL_EDIT_GRACE_MS - (Date.now() - lastLocalEditAt.current)
      if (remaining <= 0) {
        applyRemoteDraft(pending)
      } else {
        if (pendingRemoteTimer.current !== undefined) clearTimeout(pendingRemoteTimer.current)
        pendingRemoteTimer.current = setTimeout(() => {
          pendingRemoteTimer.current = undefined
          const latest = pendingRemote.current
          if (latest === undefined || composing.current) return
          applyRemoteDraft(latest)
        }, remaining)
      }
    }
    setSyncTick((tick) => tick + 1)
  }

  const acceptCommand = (command: MobileAvailableCommand): void => {
    if (slash === null) return
    const next = applySlashCommand(value, slash.tokenEnd, command.name)
    if (next.text.length > MAX_PROMPT_LENGTH) return
    interacted.current = true
    lastLocalEditAt.current = Date.now()
    pendingCaret.current = next.caret
    setCaretRequest((request) => request + 1)
    setValue(next.text)
    setCaret(next.caret)
    setSlashDismissed(true)
  }

  const insertSlash = (): void => {
    if (disabled || value !== '') return
    interacted.current = true
    lastLocalEditAt.current = Date.now()
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
    if (!slashOpen || event.nativeEvent.isComposing) return
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
  }

  const handleFocus = (): void => setFocused(true)

  // A click on a suggestion blurs the textarea before the click lands; keep the
  // list mounted until the next turn and only then decide it really lost focus.
  const handleBlur = (): void => {
    window.setTimeout(() => {
      if (document.activeElement !== textareaRef.current) setFocused(false)
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
      )
      setValue('')
      releaseAllPreviewUrls(previewUrls.current)
      setAttachments([])
      setRemovedDraftImages(new Set())
      setRemovedDraftFiles(new Set())
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
    lastLocalEditAt.current = Date.now()
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
            lastLocalEditAt.current = Date.now()
            setRemovedDraftImages((current) => new Set(current).add(id))
          }}
        />
      )}
      {((draft?.refs?.length ?? 0) > 0 || (draft?.contexts?.length ?? 0) > 0) && (
        <div className="composer__attachments" data-testid="composer-draft-refs">
          {draft?.refs?.map((ref) => (
            <span key={ref.id} className="composer__chip">
              <span className="composer__chip-name">
                {ref.kind === 'symbol' || ref.kind === 'scmChange' ? '#' : '@'}
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
                  lastLocalEditAt.current = Date.now()
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
          aria-controls={slashOpen ? SLASH_COMMAND_LIST_ID : undefined}
          aria-expanded={slashOpen}
          aria-activedescendant={slashOpen ? slashCommandOptionId(activeSlashIndex) : undefined}
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
): void {
  try {
    const storage = globalThis.sessionStorage
    if (value === '') {
      storage?.removeItem(draftKey(sessionKey))
    } else {
      storage?.setItem(draftKey(sessionKey), JSON.stringify({ text: value, caret, updatedAt: now }))
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
    const record = parsed as { text?: unknown; caret?: unknown }
    if (typeof record.text !== 'string' || typeof record.caret !== 'number') return undefined
    return { text: record.text, caret: record.caret }
  } catch {
    return undefined
  }
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
