import { useEffect, useState } from 'react'
import { ImagePreviewOverlay } from '../components/ImagePreviewOverlay.js'
import { strings } from '../strings.js'
import type { MarkdownImageSource } from './imageSource.js'

export interface MarkdownImageLoader {
  fetchWorkspaceImageBlob(src: string): Promise<Blob>
}

export interface MarkdownImageProps {
  readonly source: MarkdownImageSource
  readonly alt: string
  readonly loader: MarkdownImageLoader | undefined
}

export function MarkdownImage({ source, alt, loader }: MarkdownImageProps) {
  const kind = source.kind
  const src = source.src
  const [url, setUrl] = useState<string | undefined>(kind === 'direct' ? src : undefined)
  const [failed, setFailed] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    if (kind === 'direct') {
      setUrl(src)
      setFailed(false)
      return
    }
    if (loader === undefined) return
    let cancelled = false
    let objectUrl: string | undefined
    setUrl(undefined)
    setFailed(false)
    void loader
      .fetchWorkspaceImageBlob(src)
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
  }, [loader, kind, src])

  if (failed) {
    return (
      <span className="md-image-failed" data-testid="markdown-image-failed">
        {strings.markdownImageLoadFailed}
      </span>
    )
  }

  if (url === undefined) {
    return <span className="md-image-loading" data-testid="markdown-image-loading" aria-hidden />
  }

  return (
    <>
      <button
        type="button"
        className="md-image-button"
        data-testid="markdown-image"
        aria-label={strings.imagePreviewOpen(alt === '' ? strings.messageImageAlt : alt)}
        onClick={() => setPreviewing(true)}
      >
        <img
          className="md-image"
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </button>
      {previewing && (
        <ImagePreviewOverlay
          src={url}
          alt={alt === '' ? strings.messageImageAlt : alt}
          onClose={() => setPreviewing(false)}
        />
      )}
    </>
  )
}
