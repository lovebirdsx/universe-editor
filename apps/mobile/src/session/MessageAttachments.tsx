import type { MobileMessageAttachment } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { ImagePreviewOverlay } from '../components/ImagePreviewOverlay.js'
import { formatAttachmentSize, strings } from '../strings.js'

export interface AttachmentBlobSource {
  fetchAttachmentBlob(attachmentId: string): Promise<Blob>
}

export interface MessageAttachmentsProps {
  readonly attachments: readonly MobileMessageAttachment[]
  readonly client: AttachmentBlobSource
}

/** Image thumbnails and file cards for a user message sent from the phone. */
export function MessageAttachments({ attachments, client }: MessageAttachmentsProps) {
  return (
    <div className="message__attachments" data-testid="user-attachments">
      {attachments.map((attachment) =>
        attachment.kind === 'image' ? (
          <AttachmentImage key={attachment.id} attachment={attachment} client={client} />
        ) : (
          <div
            key={attachment.id}
            className="message__attachment-file"
            data-testid="user-attachment-file"
          >
            <span className="message__attachment-icon" aria-hidden="true">
              📄
            </span>
            <span className="message__attachment-name">{attachment.name}</span>
            <span className="message__attachment-size">
              {formatAttachmentSize(attachment.size)}
            </span>
          </div>
        ),
      )}
    </div>
  )
}

function AttachmentImage({
  attachment,
  client,
}: {
  readonly attachment: MobileMessageAttachment
  readonly client: AttachmentBlobSource
}) {
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | undefined
    setUrl(undefined)
    setFailed(false)
    void client
      .fetchAttachmentBlob(attachment.id)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.id, client])

  if (failed) {
    return (
      <div
        className="message__attachment-file message__attachment-file--failed"
        data-testid="user-attachment-image"
      >
        <span className="message__attachment-icon" aria-hidden="true">
          🖼️
        </span>
        <span className="message__attachment-name">{attachment.name}</span>
        <span className="message__attachment-size">{strings.attachmentImageLoadFailed}</span>
      </div>
    )
  }

  return (
    <div className="message__attachment-image" data-testid="user-attachment-image">
      {url !== undefined ? (
        <button
          type="button"
          className="message__attachment-image-button"
          data-testid="user-attachment-image-button"
          aria-label={strings.imagePreviewOpen(
            attachment.name === '' ? strings.attachmentImageAlt : attachment.name,
          )}
          onClick={() => setPreviewing(true)}
        >
          <img
            src={url}
            alt={attachment.name === '' ? strings.attachmentImageAlt : attachment.name}
            loading="lazy"
          />
        </button>
      ) : (
        <span className="message__attachment-placeholder" aria-hidden="true" />
      )}
      {previewing && url !== undefined && (
        <ImagePreviewOverlay
          src={url}
          alt={attachment.name === '' ? strings.attachmentImageAlt : attachment.name}
          onClose={() => setPreviewing(false)}
        />
      )}
    </div>
  )
}
