import type { MobileDeliveryPreview, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { Spinner } from '../components/Spinner.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import type { MobileClient } from '../state/mobileClient.js'
import { DeliveryCommitList, DeliveryErrorList } from './DeliveryParts.js'

export interface DeliveryConfirmSheetProps {
  readonly client: Pick<MobileClient, 'previewDelivery' | 'startDelivery'>
  readonly session: MobileSessionSummary
  readonly online: boolean
  readonly onDismiss: () => void
  readonly onStarted: (deliveryId: string) => void
  readonly onNotice: (text: string) => void
}

/** Preview + confirmation before any repository write happens. */
export function DeliveryConfirmSheet({
  client,
  session,
  online,
  onDismiss,
  onStarted,
  onNotice,
}: DeliveryConfirmSheetProps) {
  const [preview, setPreview] = useState<MobileDeliveryPreview | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let cancelled = false
    void client.previewDelivery(session.ref).then(
      (value) => {
        if (!cancelled) setPreview(value)
      },
      (error: unknown) => {
        if (!cancelled) setFailure(commandErrorText(errorCode(error)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [client, session.ref])

  const start = (): void => {
    if (starting || preview === undefined) return
    setStarting(true)
    void client.startDelivery(session.ref, preview.expectation).then(
      (result) => {
        setStarting(false)
        onStarted(result.deliveryId)
      },
      (error: unknown) => {
        setStarting(false)
        onNotice(commandErrorText(errorCode(error)))
      },
    )
  }

  const blocked = preview !== undefined && preview.blockers.length > 0

  return (
    <BottomSheet
      title={strings.deliveryConfirmTitle}
      testId="delivery-confirm-sheet"
      tone="neutral"
      overlay
      onDismiss={starting ? undefined : onDismiss}
      footer={
        <div className="sheet-options">
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="delivery-start"
            disabled={!online || starting || preview === undefined || blocked}
            onClick={start}
          >
            {starting ? strings.deliveryStarting : strings.deliveryStart}
          </button>
          <button
            type="button"
            className="sheet-option sheet-option--cancel"
            data-testid="delivery-confirm-cancel"
            disabled={starting}
            onClick={onDismiss}
          >
            {strings.deliveryCancel}
          </button>
        </div>
      }
    >
      <div className="delivery-sheet">
        <p className="delivery-intro">{strings.deliveryConfirmIntro}</p>
        {preview === undefined && failure === undefined && (
          <div className="state-card state-card--row">
            <Spinner label={strings.deliveryPreviewLoading} />
            <p>{strings.deliveryPreviewLoading}</p>
          </div>
        )}
        {failure !== undefined && (
          <p className="delivery-failed" data-testid="delivery-preview-failed">
            {strings.deliveryPreviewFailed} {failure}
          </p>
        )}
        {preview !== undefined && (
          <>
            <section className="delivery-section">
              <h3 className="delivery-section__title">{strings.deliverySourceLabel}</h3>
              <p className="delivery-worktree-line">
                <span className="delivery-worktree-line__name">{preview.source.worktreeName}</span>
                {preview.source.branch !== undefined && (
                  <span className="delivery-worktree-line__branch">{preview.source.branch}</span>
                )}
                <span className="delivery-worktree-line__sha">
                  {preview.source.head.slice(0, 8)}
                </span>
              </p>
              {preview.source.dirty && (
                <p className="delivery-note">
                  {strings.deliverySourceDirty(
                    preview.source.changedFileCount,
                    preview.source.untrackedCount,
                  )}
                </p>
              )}
              {preview.source.dirty && <p className="delivery-note">{strings.deliveryDirtyNote}</p>}
            </section>
            <section className="delivery-section">
              <h3 className="delivery-section__title">{strings.deliveryTargetLabel}</h3>
              <p className="delivery-worktree-line">
                <span className="delivery-worktree-line__name">
                  {preview.target.mainWorktreeName}
                </span>
                <span className="delivery-worktree-line__branch">{preview.target.mainBranch}</span>
                <span className="delivery-worktree-line__sha">
                  {preview.target.mainHead.slice(0, 8)}
                </span>
              </p>
              <p className="delivery-note">
                {preview.target.upstreamRef} · {preview.target.remote}
              </p>
            </section>
            <section className="delivery-section">
              <h3 className="delivery-section__title">
                {strings.deliveryCommitsLabel(preview.commits.length)}
              </h3>
              <DeliveryCommitList commits={preview.commits} />
            </section>
            {preview.warnings.length > 0 && (
              <section className="delivery-section">
                <h3 className="delivery-section__title">{strings.deliveryWarnings}</h3>
                <ul className="delivery-warnings">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            )}
            <DeliveryErrorList errors={preview.blockers} label={strings.deliveryBlockers} />
          </>
        )}
      </div>
    </BottomSheet>
  )
}
