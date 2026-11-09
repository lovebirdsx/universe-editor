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
} from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { errorCode } from '../errors.js'
import { commandErrorText, formatAttachmentSize, strings } from '../strings.js'
import { AttachmentSheet, type AttachmentPick } from './AttachmentSheet.js'
import { useAutoGrowTextarea } from './useAutoGrowTextarea.js'

const MAX_ROWS = 6
const LINE_HEIGHT_PX = 22
const MAX_HEIGHT_PX = MAX_ROWS * LINE_HEIGHT_PX
const DRAFT_PREFIX = 'universe.mobile.draft:'

export type ComposerAttachmentStatus = 'uploading' | 'uploaded' | 'failed'

export interface ComposerAttachment {
  readonly key: string
  readonly kind: MobileAttachmentKind
  readonly name: string
  readonly size: number
  readonly status: ComposerAttachmentStatus
  readonly id?: string
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
  readonly onUploadAttachment: (
    file: File,
    kind: MobileAttachmentKind,
  ) => Promise<MobileAttachmentUploadResult>
  /** One-shot backfill (rewind text / side-task quote) owned by the session page. */
  readonly prefill?: ComposerPrefill | undefined
  readonly onSend: (text: string, attachmentIds: readonly string[]) => Promise<void>
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
  onUploadAttachment,
  prefill,
  onSend,
  onStop,
  onNotice,
}: ComposerProps) {
  const [value, setValue] = useState(() => readDraft(sessionKey))
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([])
  const [sheetOpen, setSheetOpen] = useState(false)
  const textareaRef = useAutoGrowTextarea(value, { maxHeightPx: MAX_HEIGHT_PX })
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const photosInputRef = useRef<HTMLInputElement | null>(null)
  const filesInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentSeq = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    writeDraft(sessionKey, value)
  }, [sessionKey, value])

  useEffect(() => {
    if (prefill === undefined || prefill.sessionKey !== sessionKey) return
    setValue(prefill.text)
    textareaRef.current?.focus()
  }, [prefill, sessionKey, textareaRef])

  const disabled = !online || readOnly
  const attaching = attachments.some((attachment) => attachment.status === 'uploading')
  const canAttach = (imageSupported || fileSupported) && !disabled
  const readyAttachments = attachments.filter(
    (attachment) => attachment.status === 'uploaded' && attachment.id !== undefined,
  )
  const canSend =
    !disabled &&
    !sending &&
    !stopping &&
    !attaching &&
    attachments.every((attachment) => attachment.status === 'uploaded') &&
    (value.trim() !== '' || readyAttachments.length > 0)

  const send = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    try {
      await onSend(
        value,
        readyAttachments.map((attachment) => attachment.id as string),
      )
      setValue('')
      setAttachments([])
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

  const pick = (pick: AttachmentPick): void => {
    setSheetOpen(false)
    if (pick === 'camera') cameraInputRef.current?.click()
    else if (pick === 'photos') photosInputRef.current?.click()
    else filesInputRef.current?.click()
  }

  const acceptFiles = (files: readonly File[], source: 'image' | 'file'): void => {
    if (files.length === 0) return
    if (disabled || attaching) return
    let count = attachments.length
    let imageCount = attachments.filter((attachment) => attachment.kind === 'image').length
    let totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
    const accepted: Array<{ readonly file: File; readonly kind: MobileAttachmentKind }> = []
    for (const file of files) {
      const kind: MobileAttachmentKind = source === 'image' ? 'image' : 'file'
      if (count >= MAX_ATTACHMENTS_PER_PROMPT) {
        onNotice(strings.attachmentTooMany)
        break
      }
      if (kind === 'image') {
        if (!isMobileImageMimeType(file.type)) {
          onNotice(strings.attachmentUnsupportedImage)
          continue
        }
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

    const pending = accepted.map(({ file, kind }) => {
      attachmentSeq.current += 1
      return {
        key: `a${attachmentSeq.current}`,
        kind,
        name: file.name.trim() === '' ? 'attachment' : file.name,
        size: file.size,
        status: 'uploading' as const,
      }
    })
    setAttachments((current) => [...current, ...pending])
    void uploadAll(accepted, pending)
  }

  const pickFiles = (event: ChangeEvent<HTMLInputElement>, source: 'image' | 'file'): void => {
    const input = event.currentTarget
    // Clearing the input mutates the live FileList, so snapshot it first.
    const files = Array.from(input.files ?? [])
    input.value = ''
    acceptFiles(files, source)
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
        setAttachments((current) =>
          current.map((attachment) =>
            attachment.key === chip.key
              ? {
                  ...attachment,
                  status: 'uploaded',
                  id: result.id,
                  name: result.name,
                  size: result.size,
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
      {attachments.length > 0 && (
        <div className="composer__attachments" data-testid="composer-attachments">
          {attachments.map((attachment) => (
            <div
              key={attachment.key}
              className={`composer__chip composer__chip--${attachment.status}`}
              data-testid={`composer-attachment-${attachment.kind}`}
            >
              <span className="composer__chip-name">{attachment.name}</span>
              <span className="composer__chip-size">{formatAttachmentSize(attachment.size)}</span>
              {attachment.status === 'uploading' && (
                <span className="composer__chip-status">{strings.attachmentUploading}</span>
              )}
              {attachment.status === 'failed' && (
                <span className="composer__chip-status composer__chip-status--failed">
                  {strings.attachmentUploadFailed}
                </span>
              )}
              <button
                type="button"
                className="composer__chip-remove"
                aria-label={strings.attachmentRemove}
                disabled={sending || attachment.status === 'uploading'}
                onClick={() => removeAttachment(attachment.key)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer__row">
        {canAttach && (
          <button
            type="button"
            className="composer__attach"
            data-testid="composer-attach"
            aria-label={strings.composerAttach}
            disabled={sending || stopping || attaching}
            onClick={() => setSheetOpen(true)}
          >
            +
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
          placeholder={online ? strings.composerPlaceholder : strings.composerOffline}
          aria-label={strings.composerPlaceholder}
          onChange={(event) => setValue(event.target.value)}
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
      {imageSupported && !disabled && (
        <>
          <input
            ref={cameraInputRef}
            className="composer__file-input"
            data-testid="composer-camera-input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => pickFiles(event, 'image')}
          />
          <input
            ref={photosInputRef}
            className="composer__file-input"
            data-testid="composer-photo-input"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => pickFiles(event, 'image')}
          />
        </>
      )}
      {fileSupported && !disabled && (
        <input
          ref={filesInputRef}
          className="composer__file-input"
          data-testid="composer-file-input"
          type="file"
          multiple
          onChange={(event) => pickFiles(event, 'file')}
        />
      )}
      {sheetOpen && canAttach && (
        <AttachmentSheet
          imageSupported={imageSupported}
          fileSupported={fileSupported}
          onPick={pick}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  )
}

export function draftKey(sessionKey: string): string {
  return `${DRAFT_PREFIX}${sessionKey}`
}

export function readDraft(sessionKey: string): string {
  try {
    return globalThis.sessionStorage?.getItem(draftKey(sessionKey)) ?? ''
  } catch {
    return ''
  }
}

export function writeDraft(sessionKey: string, value: string): void {
  try {
    if (value === '') globalThis.sessionStorage?.removeItem(draftKey(sessionKey))
    else globalThis.sessionStorage?.setItem(draftKey(sessionKey), value)
  } catch {
    // Storage can be unavailable (private mode); the draft is a convenience only.
  }
}

export function clearDraft(sessionKey: string): void {
  writeDraft(sessionKey, '')
}
