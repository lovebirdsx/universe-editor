import type {
  MobileDeliveryExpectation,
  MobileDeliveryPreview,
  MobileSessionSummary,
} from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { Spinner } from '../components/Spinner.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import type { MobileClient } from '../state/mobileClient.js'
import { localRefKey } from '../state/refs.js'
import { DeliveryCommitList, DeliveryErrorList } from './DeliveryParts.js'

export interface DeliveryConfirmSheetProps {
  readonly client: Pick<MobileClient, 'previewDelivery'>
  readonly session: MobileSessionSummary
  readonly online: boolean
  readonly onDismiss: () => void
  readonly onStart: (expectation: MobileDeliveryExpectation) => void
}

/** Preview + confirmation before any repository write happens. */
export function DeliveryConfirmSheet({
  client,
  session,
  online,
  onDismiss,
  onStart,
}: DeliveryConfirmSheetProps) {
  const [preview, setPreview] = useState<MobileDeliveryPreview | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const submitted = useRef(false)
  // Keep the newest ref object without re-running the preview when the inbox
  // pushes replace the session object but keep the same local identity.
  const sessionRef = useRef(session.ref)
  sessionRef.current = session.ref
  const sessionKey = localRefKey(sessionRef.current)

  useEffect(() => {
    let cancelled = false
    void client.previewDelivery(sessionRef.current).then(
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
  }, [client, sessionKey])

  const start = (): void => {
    if (submitted.current || preview === undefined) return
    submitted.current = true
    onStart(preview.expectation)
  }

  const blocked = preview !== undefined && preview.blockers.length > 0

  return (
    <BottomSheet
      title={strings.deliveryConfirmTitle}
      testId="delivery-confirm-sheet"
      tone="neutral"
      overlay
      onDismiss={onDismiss}
      footer={
        <div className="sheet-options">
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="delivery-start"
            disabled={!online || preview === undefined || blocked}
            onClick={start}
          >
            {strings.deliveryStart}
          </button>
          <button
            type="button"
            className="sheet-option sheet-option--cancel"
            data-testid="delivery-confirm-cancel"
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
