import { useState } from 'react'
import { ImagePreviewOverlay } from '../components/ImagePreviewOverlay.js'
import { formatAttachmentSize, strings } from '../strings.js'
import type { ComposerAttachment } from './Composer.js'

export interface ComposerAttachmentChipProps {
  readonly attachment: ComposerAttachment
  readonly sending: boolean
  readonly onRemove: (key: string) => void
}

/** Image chips show a local thumbnail that opens the full-screen viewer; files stay text chips. */
export function ComposerAttachmentChip({
  attachment,
  sending,
  onRemove,
}: ComposerAttachmentChipProps) {
  if (attachment.kind === 'image' && attachment.previewUrl !== undefined) {
    return (
      <ImageAttachmentChip
        attachment={attachment}
        previewUrl={attachment.previewUrl}
        sending={sending}
        onRemove={onRemove}
      />
    )
  }
  return <FileAttachmentChip attachment={attachment} sending={sending} onRemove={onRemove} />
}

interface ChipProps {
  readonly attachment: ComposerAttachment
  readonly sending: boolean
  readonly onRemove: (key: string) => void
}

function ImageAttachmentChip({
  attachment,
  previewUrl,
  sending,
  onRemove,
}: ChipProps & { readonly previewUrl: string }) {
  const [previewing, setPreviewing] = useState(false)
  return (
    <div
      className={`composer__chip composer__chip--image composer__chip--${attachment.status}`}
      data-testid="composer-attachment-image"
    >
      <button
        type="button"
        className="composer__chip-thumb"
        data-testid="composer-attachment-image-button"
        aria-label={strings.imagePreviewOpen(attachment.name)}
        onClick={() => setPreviewing(true)}
      >
        <img src={previewUrl} alt={attachment.name} />
      </button>
      <ChipContent attachment={attachment} sending={sending} onRemove={onRemove} />
      {previewing && (
        <ImagePreviewOverlay
          src={previewUrl}
          alt={attachment.name}
          onClose={() => setPreviewing(false)}
        />
      )}
    </div>
  )
}

function FileAttachmentChip({ attachment, sending, onRemove }: ChipProps) {
  return (
    <div
      className={`composer__chip composer__chip--${attachment.status}`}
      data-testid="composer-attachment-file"
    >
      <ChipContent attachment={attachment} sending={sending} onRemove={onRemove} />
    </div>
  )
}

function ChipContent({ attachment, sending, onRemove }: ChipProps) {
  return (
    <>
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
        onClick={() => onRemove(attachment.key)}
      >
        ×
      </button>
    </>
  )
}
