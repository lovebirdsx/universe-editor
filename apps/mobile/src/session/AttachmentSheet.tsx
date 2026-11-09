import { BottomSheet } from '../components/BottomSheet.js'
import { strings } from '../strings.js'

export type AttachmentPick = 'camera' | 'photos' | 'files'

export interface AttachmentSheetProps {
  readonly imageSupported: boolean
  readonly fileSupported: boolean
  readonly onPick: (pick: AttachmentPick) => void
  readonly onClose: () => void
}

/** Overlay entry points for the composer's attachment button. */
export function AttachmentSheet({
  imageSupported,
  fileSupported,
  onPick,
  onClose,
}: AttachmentSheetProps) {
  return (
    <BottomSheet
      title={strings.composerAttachTitle}
      icon="📎"
      testId="attachment-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
    >
      <div className="attachment-sheet">
        {imageSupported && (
          <button
            type="button"
            className="attachment-sheet__option"
            data-testid="attachment-camera"
            onClick={() => onPick('camera')}
          >
            <span className="attachment-sheet__icon" aria-hidden="true">
              📷
            </span>
            {strings.composerAttachCamera}
          </button>
        )}
        {imageSupported && (
          <button
            type="button"
            className="attachment-sheet__option"
            data-testid="attachment-photos"
            onClick={() => onPick('photos')}
          >
            <span className="attachment-sheet__icon" aria-hidden="true">
              🖼️
            </span>
            {strings.composerAttachPhotos}
          </button>
        )}
        {fileSupported && (
          <button
            type="button"
            className="attachment-sheet__option"
            data-testid="attachment-files"
            onClick={() => onPick('files')}
          >
            <span className="attachment-sheet__icon" aria-hidden="true">
              📄
            </span>
            {strings.composerAttachFiles}
          </button>
        )}
      </div>
      <button
        type="button"
        className="attachment-sheet__cancel"
        data-testid="attachment-cancel"
        onClick={onClose}
      >
        {strings.composerAttachCancel}
      </button>
    </BottomSheet>
  )
}
