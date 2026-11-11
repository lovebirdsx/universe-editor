import type { MobileDeliveryDetail, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { ConfirmActionSheet } from '../components/ConfirmActionSheet.js'
import { Spinner } from '../components/Spinner.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import type { MobileClient } from '../state/mobileClient.js'
import { deliveryTone } from './deliveryStatus.js'
import { DeliveryCommitList, DeliveryErrorList, DeliveryWorktreeResults } from './DeliveryParts.js'

type DetailView = 'detail' | 'confirm-push' | 'confirm-undo'
type DeliveryAction = 'push' | 'retry' | 'undo' | 'open'

export interface DeliveryDetailSheetProps {
  readonly client: Pick<
    MobileClient,
    | 'getDelivery'
    | 'confirmDeliveryPush'
    | 'retryDelivery'
    | 'undoDelivery'
    | 'openDeliveryMainWorktree'
  >
  readonly session: MobileSessionSummary
  readonly deliveryId: string
  readonly online: boolean
  readonly onDismiss: () => void
  readonly onOpenSession: () => void
  /** Start another delivery once the latest one has fully synced. */
  readonly onStartDelivery: () => void
  readonly onNotice: (text: string) => void
}

/** Delivery status, commit list and the push / retry / undo actions. */
export function DeliveryDetailSheet({
  client,
  session,
  deliveryId,
  online,
  onDismiss,
  onOpenSession,
  onStartDelivery,
  onNotice,
}: DeliveryDetailSheetProps) {
  const [detail, setDetail] = useState<MobileDeliveryDetail | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<DeliveryAction | undefined>(undefined)
  const [view, setView] = useState<DetailView>('detail')
  const [reloadToken, setReloadToken] = useState(0)
  const summaryUpdatedAt = session.delivery?.updatedAt

  useEffect(() => {
    let cancelled = false
    setFailure(undefined)
    void client.getDelivery(session.ref, deliveryId).then(
      (value) => {
        if (!cancelled) setDetail(value)
      },
      (error: unknown) => {
        if (!cancelled) setFailure(commandErrorText(errorCode(error)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [client, session.ref, deliveryId, reloadToken, summaryUpdatedAt])

  const run = (action: DeliveryAction, request: () => Promise<void>): void => {
    if (busy !== undefined) return
    setBusy(action)
    void request().then(
      () => {
        setBusy(undefined)
        setView('detail')
        setReloadToken((value) => value + 1)
      },
      (error: unknown) => {
        setBusy(undefined)
        onNotice(commandErrorText(errorCode(error)))
      },
    )
  }

  if (view === 'confirm-push') {
    return (
      <ConfirmActionSheet
        title={strings.deliveryConfirmPushTitle}
        body={strings.deliveryConfirmPushBody}
        confirmLabel={strings.deliveryConfirmPush}
        testId="delivery-push-confirm-sheet"
        busy={busy === 'push'}
        disabled={!online}
        onConfirm={() => run('push', () => client.confirmDeliveryPush(session.ref, deliveryId))}
        onCancel={() => {
          if (busy === undefined) setView('detail')
        }}
      />
    )
  }

  if (view === 'confirm-undo') {
    return (
      <ConfirmActionSheet
        title={strings.deliveryUndoTitle}
        body={strings.deliveryUndoBody}
        confirmLabel={strings.deliveryUndo}
        testId="delivery-undo-confirm-sheet"
        tone="danger"
        busy={busy === 'undo'}
        disabled={!online}
        onConfirm={() => run('undo', () => client.undoDelivery(session.ref, deliveryId))}
        onCancel={() => {
          if (busy === undefined) setView('detail')
        }}
      />
    )
  }

  const summary = detail?.summary
  const disabled = !online || busy !== undefined

  return (
    <BottomSheet
      title={strings.deliveryDetailTitle}
      testId="delivery-detail-sheet"
      tone="neutral"
      overlay
      onDismiss={busy === undefined ? onDismiss : undefined}
      footer={
        <div className="delivery-actions">
          {summary?.canConfirmPush === true && (
            <button
              type="button"
              className="sheet-option sheet-option--neutral"
              data-testid="delivery-confirm-push"
              disabled={disabled}
              onClick={() => setView('confirm-push')}
            >
              {busy === 'push' ? strings.deliveryPushing : strings.deliveryConfirmPush}
            </button>
          )}
          {summary?.canRetry === true && (
            <button
              type="button"
              className="sheet-option sheet-option--neutral"
              data-testid="delivery-retry"
              disabled={disabled}
              onClick={() => run('retry', () => client.retryDelivery(session.ref, deliveryId))}
            >
              {busy === 'retry' ? strings.deliveryRetrying : strings.deliveryRetry}
            </button>
          )}
          {summary?.canUndo === true && (
            <button
              type="button"
              className="sheet-option sheet-option--danger"
              data-testid="delivery-undo"
              disabled={disabled}
              onClick={() => setView('confirm-undo')}
            >
              {busy === 'undo' ? strings.deliveryUndoing : strings.deliveryUndo}
            </button>
          )}
          {summary?.phase === 'synced' && (
            <button
              type="button"
              className="sheet-option sheet-option--neutral"
              data-testid="delivery-start-again"
              disabled={disabled}
              onClick={onStartDelivery}
            >
              {strings.deliveryAgain}
            </button>
          )}
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="delivery-open-main"
            disabled={disabled}
            onClick={() =>
              run('open', () => client.openDeliveryMainWorktree(session.ref, deliveryId))
            }
          >
            {busy === 'open'
              ? strings.deliveryOpeningMainWorktree
              : strings.deliveryOpenMainWorktree}
          </button>
          <button
            type="button"
            className="sheet-option sheet-option--cancel"
            data-testid="delivery-detail-close"
            disabled={busy !== undefined}
            onClick={onDismiss}
          >
            {strings.deliveryClose}
          </button>
        </div>
      }
    >
      <div className="delivery-sheet">
        {detail === undefined && failure === undefined && (
          <div className="state-card state-card--row">
            <Spinner label={strings.deliveryLoading} />
            <p>{strings.deliveryLoading}</p>
          </div>
        )}
        {failure !== undefined && (
          <p className="delivery-failed" data-testid="delivery-detail-failed">
            {strings.deliveryDetailFailed} {failure}
          </p>
        )}
        {detail !== undefined && summary !== undefined && (
          <>
            <section className="delivery-section">
              <span
                className={`delivery-badge delivery-badge--${deliveryTone(summary.phase)}`}
                data-testid="delivery-detail-phase"
              >
                {strings.deliveryPhaseLabel(summary.phase)}
              </span>
              <p className="delivery-note">
                {strings.deliverySummaryCommits(summary.commitCount)}
                {summary.dirtySource ? ` · ${strings.deliverySummaryDirty}` : ''}
                {' · '}
                {summary.mainBranch}
              </p>
              <p className="delivery-note">
                {strings.deliverySummarySync(
                  summary.sync.synced,
                  summary.sync.skipped,
                  summary.sync.failed,
                )}
              </p>
            </section>
            {summary.error !== undefined && (
              <DeliveryErrorList errors={[summary.error]} label={strings.deliveryErrorLabel} />
            )}
            {detail.conflictFiles.length > 0 && (
              <section className="delivery-section">
                <h3 className="delivery-section__title">
                  {strings.deliveryConflictLabel(detail.conflictFiles.length)}
                </h3>
                <ul className="delivery-conflicts" data-testid="delivery-conflicts">
                  {detail.conflictFiles.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </section>
            )}
            <section className="delivery-section">
              <h3 className="delivery-section__title">
                {strings.deliveryCommitsLabel(detail.commits.length)}
              </h3>
              <DeliveryCommitList commits={detail.commits} />
            </section>
            {detail.pushedSha !== undefined && (
              <section className="delivery-section">
                <h3 className="delivery-section__title">{strings.deliveryPushLabel}</h3>
                <p className="delivery-note">
                  {strings.deliveryPushedTo(
                    `${detail.remoteRef ?? detail.target.upstreamRef} @ ${detail.pushedSha.slice(0, 8)}`,
                  )}
                </p>
              </section>
            )}
            <DeliveryWorktreeResults results={detail.syncResults} />
            {detail.undo !== undefined && (
              <section className="delivery-section">
                <h3 className="delivery-section__title">{strings.deliveryUndo}</h3>
                <p className="delivery-note">
                  {detail.undo.revertedShas.map((sha) => sha.slice(0, 8)).join(', ')}
                </p>
              </section>
            )}
            <button
              type="button"
              className="button button--primary delivery-open-session"
              data-testid="delivery-open-session"
              onClick={onOpenSession}
            >
              {strings.deliveryOpenSession}
            </button>
          </>
        )}
      </div>
    </BottomSheet>
  )
}
