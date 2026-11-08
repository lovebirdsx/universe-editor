import { MAX_PROMPT_LENGTH } from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState } from 'react'
import { commandErrorText, strings } from '../strings.js'

const MAX_ROWS = 6
const LINE_HEIGHT_PX = 22
const MAX_HEIGHT_PX = MAX_ROWS * LINE_HEIGHT_PX
const DRAFT_PREFIX = 'universe.mobile.draft:'

export interface ComposerProps {
  readonly sessionKey: string
  readonly readOnly: boolean
  readonly running: boolean
  readonly online: boolean
  readonly onSend: (text: string) => Promise<void>
  readonly onStop: () => Promise<void>
  readonly onNotice: (text: string) => void
}

export function Composer({
  sessionKey,
  readOnly,
  running,
  online,
  onSend,
  onStop,
  onNotice,
}: ComposerProps) {
  const [value, setValue] = useState(() => readDraft(sessionKey))
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    writeDraft(sessionKey, value)
  }, [sessionKey, value])

  useEffect(() => {
    const element = textareaRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value])

  const disabled = !online || readOnly
  const canSend = value.trim() !== '' && !disabled && !sending && !stopping

  const send = async (): Promise<void> => {
    const text = value
    if (text.trim() === '' || !canSend) return
    setSending(true)
    try {
      await onSend(text)
      setValue('')
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

  return (
    <div className="composer" data-testid="composer">
      {disabled && (
        <p className={`composer__hint${online ? '' : ' composer__hint--danger'}`}>
          {online ? strings.composerReadOnly : strings.composerOffline}
        </p>
      )}
      {!disabled && running && <p className="composer__hint">{strings.composerStopHint}</p>}
      <div className="composer__row">
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
        {value.trim() !== '' && (
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

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
