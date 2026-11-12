import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { writeClipboardImage } from '../clipboard.js'
import { useDocumentScrollLock } from '../components/useDocumentScrollLock.js'
import { strings } from '../strings.js'

export interface CopyImageOverlayProps {
  readonly blob: Blob
  readonly onClose: () => void
  readonly onCopied: () => void
}

const FILE_NAME = 'message.png'

/**
 * Fallback when the browser cannot write images to the clipboard. The image is
 * deliberately left selectable/callout-friendly so iOS long-press can copy or
 * save it; explicit buttons cover browsers where that menu is unavailable.
 */
export function CopyImageOverlay({ blob, onClose, onCopied }: CopyImageOverlayProps) {
  useDocumentScrollLock(true)
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const previousFocus = useRef<Element | null>(null)

  useEffect(() => {
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])

  useEffect(() => {
    previousFocus.current = document.activeElement
    closeButton.current?.focus()
    return () => {
      const target = previousFocus.current
      if (target instanceof HTMLElement) target.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const file = useMemo(() => new File([blob], FILE_NAME, { type: 'image/png' }), [blob])
  const canShare = useMemo(() => {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false
    if (typeof navigator.canShare !== 'function') return false
    try {
      return navigator.canShare({ files: [file] })
    } catch {
      return false
    }
  }, [file])

  const copy = (): void => {
    setStatus(undefined)
    void writeClipboardImage(blob).then((ok) => {
      if (ok) onCopied()
      else setStatus(strings.copyImagePreviewCopyFailed)
    })
  }

  const share = (): void => {
    if (typeof navigator.share !== 'function') return
    setStatus(undefined)
    try {
      void navigator
        .share({ files: [file], title: strings.copyImagePreviewTitle })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setStatus(strings.copyImagePreviewShareFailed)
        })
    } catch {
      setStatus(strings.copyImagePreviewShareFailed)
    }
  }

  const surface = (
    <div
      className="copy-image-preview"
      data-testid="copy-image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={strings.copyImagePreviewTitle}
    >
      <div className="copy-image-preview__bar">
        <span className="copy-image-preview__title">{strings.copyImagePreviewTitle}</span>
        <button
          ref={closeButton}
          type="button"
          className="copy-image-preview__close"
          data-testid="copy-image-preview-close"
          aria-label={strings.imagePreviewClose}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="copy-image-preview__stage">
        {url !== undefined && (
          <img
            className="copy-image-preview__image"
            src={url}
            alt={strings.copyImagePreviewTitle}
            data-testid="copy-image-preview-image"
          />
        )}
      </div>
      <p className="copy-image-preview__hint">{strings.copyImagePreviewHint}</p>
      <p className="copy-image-preview__status" role="status">
        {status ?? ''}
      </p>
      <div className="copy-image-preview__actions">
        <button
          type="button"
          className="copy-image-preview__action"
          data-testid="copy-image-preview-copy"
          onClick={copy}
        >
          {strings.copyImagePreviewCopy}
        </button>
        {canShare && (
          <button
            type="button"
            className="copy-image-preview__action"
            data-testid="copy-image-preview-share"
            onClick={share}
          >
            {strings.copyImagePreviewShare}
          </button>
        )}
        {url !== undefined && (
          <a
            className="copy-image-preview__action"
            data-testid="copy-image-preview-save"
            href={url}
            download={FILE_NAME}
          >
            {strings.copyImagePreviewSave}
          </a>
        )}
      </div>
    </div>
  )
  return createPortal(surface, document.body)
}
