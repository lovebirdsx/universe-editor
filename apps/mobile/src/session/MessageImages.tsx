import type { MobileMessageImage } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { ImagePreviewOverlay } from '../components/ImagePreviewOverlay.js'
import { strings } from '../strings.js'

export interface MessageImageBlobSource {
  fetchMessageImageBlob(messageId: string, index: number): Promise<Blob>
}

export interface MessageImagesProps {
  readonly messageId: string
  readonly images: readonly MobileMessageImage[]
  readonly client: MessageImageBlobSource
}

/** ACP image blocks attached to one timeline message (agent reply / PC paste). */
export function MessageImages({ messageId, images, client }: MessageImagesProps) {
  if (images.length === 0) return null
  return (
    <div className="message__images" data-testid="message-images">
      {images.map((image, ordinal) => (
        <MessageImage
          key={image.index}
          messageId={messageId}
          image={image}
          ordinal={ordinal}
          client={client}
        />
      ))}
    </div>
  )
}

function MessageImage({
  messageId,
  image,
  ordinal,
  client,
}: {
  readonly messageId: string
  readonly image: MobileMessageImage
  readonly ordinal: number
  readonly client: MessageImageBlobSource
}) {
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    if (image.truncated === true) return
    let cancelled = false
    let objectUrl: string | undefined
    setUrl(undefined)
    setFailed(false)
    void client
      .fetchMessageImageBlob(messageId, image.index)
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
  }, [client, messageId, image.index, image.truncated])

  if (image.truncated === true || failed) {
    return (
      <div
        className="message__image message__image--unavailable"
        data-testid="message-image-unavailable"
      >
        {image.truncated === true
          ? strings.messageImageUnavailable
          : strings.messageImageLoadFailed}
      </div>
    )
  }

  if (url === undefined) {
    return (
      <div
        className="message__image message__image--loading"
        data-testid="message-image-loading"
        aria-hidden="true"
      />
    )
  }

  return (
    <>
      <button
        type="button"
        className="message__image-button"
        data-testid="message-image"
        aria-label={strings.messageImageOpen(ordinal)}
        onClick={() => setPreviewing(true)}
      >
        <img className="message__image" src={url} alt={strings.messageImageAlt} loading="lazy" />
      </button>
      {previewing && (
        <ImagePreviewOverlay
          src={url}
          alt={strings.messageImageAlt}
          onClose={() => setPreviewing(false)}
        />
      )}
    </>
  )
}
