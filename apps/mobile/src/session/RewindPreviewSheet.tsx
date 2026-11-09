import type { MobileRewindPreview } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { Spinner } from '../components/Spinner.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'

export interface RewindPreviewSheetProps {
  readonly client: Pick<MobileClient, 'previewRewind' | 'rewindSession'>
  readonly messageId: string
  readonly online: boolean
  readonly onClose: () => void
  /** Called after a successful apply; `text` is the original user message. */
  readonly onApplied: (text: string | undefined) => void
  readonly onNotice: (text: string) => void
}

type PreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly preview: MobileRewindPreview }

export function RewindPreviewSheet({
  client,
  messageId,
  online,
  onClose,
  onApplied,
  onNotice,
}: RewindPreviewSheetProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [applying, setApplying] = useState<'discard' | 'keep' | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void client.previewRewind(messageId).then(
      (preview) => {
        if (!cancelled) setState({ status: 'ready', preview })
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: 'failed', message: commandErrorText(errorCode(error)) })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [client, messageId])

  const apply = async (rewindFiles: boolean): Promise<void> => {
    if (applying !== undefined) return
    setApplying(rewindFiles ? 'discard' : 'keep')
    try {
      const result = await client.rewindSession(messageId, rewindFiles)
      if (!result.canRewind) {
        setState({
          status: 'failed',
          message: result.error ?? strings.rewindCannot,
        })
        return
      }
      onApplied(result.text)
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
    } finally {
      setApplying(undefined)
    }
  }

  const preview = state.status === 'ready' ? state.preview : undefined

  return (
    <BottomSheet
      title={strings.rewindTitle}
      testId="rewind-sheet"
      tone="warning"
      overlay
      onDismiss={onClose}
      expandKey="rewind"
    >
      {state.status === 'loading' && (
        <div className="sheet-loading" data-testid="rewind-loading">
          <Spinner label={strings.rewindLoading} />
          <p className="muted">{strings.rewindLoading}</p>
        </div>
      )}
      {state.status === 'failed' && (
        <p className="sheet-field__error" data-testid="rewind-error">
          {state.message}
        </p>
      )}
      {preview !== undefined && (
        <>
          {preview.canRewind ? (
            <p className="sheet__request" data-testid="rewind-impact">
              {rewindImpactText(preview)}
            </p>
          ) : (
            <p className="sheet-field__error" data-testid="rewind-error">
              {preview.error ?? strings.rewindCannot}
            </p>
          )}
          <div className="sheet-options">
            {preview.canRewind && (
              <>
                <button
                  type="button"
                  className="sheet-option sheet-option--danger"
                  data-testid="rewind-discard"
                  disabled={!online || applying !== undefined}
                  onClick={() => void apply(true)}
                >
                  {applying === 'discard' ? strings.rewindApplying : strings.rewindDiscard}
                </button>
                <button
                  type="button"
                  className="sheet-option sheet-option--allow"
                  data-testid="rewind-keep"
                  disabled={!online || applying !== undefined}
                  onClick={() => void apply(false)}
                >
                  {applying === 'keep' ? strings.rewindApplying : strings.rewindKeep}
                </button>
              </>
            )}
            <button
              type="button"
              className="sheet-option sheet-option--cancel"
              data-testid="rewind-cancel"
              disabled={applying !== undefined}
              onClick={onClose}
            >
              {strings.rewindCancel}
            </button>
          </div>
        </>
      )}
    </BottomSheet>
  )
}

function rewindImpactText(preview: MobileRewindPreview): string {
  if (preview.filesChanged === 0) return strings.rewindNoFiles
  if (preview.insertions !== undefined || preview.deletions !== undefined) {
    return strings.rewindImpact(
      preview.filesChanged,
      preview.insertions ?? 0,
      preview.deletions ?? 0,
    )
  }
  return strings.rewindImpactFiles(preview.filesChanged)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
