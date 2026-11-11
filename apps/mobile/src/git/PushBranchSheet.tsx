import type {
  MobilePushBranchPreview,
  MobileSessionSummary,
} from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { Spinner } from '../components/Spinner.js'
import { errorCode } from '../errors.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'
import { DeliveryErrorList } from '../inbox/DeliveryParts.js'

export interface PushBranchSheetProps {
  readonly client: Pick<MobileClient, 'previewPushBranch' | 'pushBranch'>
  readonly session: MobileSessionSummary
  readonly online: boolean
  readonly onDismiss: () => void
  readonly onNotice: (text: string) => void
}

/** Preview + confirmation for publishing the session branch (never main). */
export function PushBranchSheet({
  client,
  session,
  online,
  onDismiss,
  onNotice,
}: PushBranchSheetProps) {
  const [preview, setPreview] = useState<MobilePushBranchPreview | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [remoteBranch, setRemoteBranch] = useState('')
  const [pushing, setPushing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void client.previewPushBranch(session.ref).then(
      (value) => {
        if (cancelled) return
        setPreview(value)
        setRemoteBranch(value.remote.branch)
      },
      (error: unknown) => {
        if (!cancelled) setFailure(commandErrorText(errorCode(error)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [client, session.ref])

  const target = remoteBranch.trim()
  const blocked = preview !== undefined && preview.blockers.length > 0
  const canPush = online && !pushing && preview !== undefined && !blocked && target.length > 0

  const push = (): void => {
    if (!canPush || preview === undefined) return
    setPushing(true)
    const edited = target !== preview.expectation.remoteBranch
    void client
      .pushBranch(session.ref, {
        branch: preview.expectation.branch,
        head: preview.expectation.head,
        remote: preview.expectation.remote,
        remoteBranch: target,
        // The pinned remote head belongs to the previewed name; a renamed
        // target must be checked from scratch by the server.
        ...(!edited && preview.expectation.remoteHead !== undefined
          ? { remoteHead: preview.expectation.remoteHead }
          : {}),
      })
      .then(
        (result) => {
          setPushing(false)
          onNotice(strings.pushBranchSuccess(result.remote, result.remoteBranch))
          onDismiss()
        },
        (error: unknown) => {
          setPushing(false)
          onNotice(commandErrorText(errorCode(error)))
        },
      )
  }

  const blockers = preview?.blockers.map((blocker) => ({
    ...blocker,
    message: strings.pushBlockerText(blocker.code, blocker.message),
  }))

  return (
    <BottomSheet
      title={strings.pushBranchTitle}
      testId="push-branch-sheet"
      tone="neutral"
      overlay
      onDismiss={pushing ? undefined : onDismiss}
      footer={
        <div className="sheet-options">
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="push-branch-start"
            disabled={!canPush}
            onClick={push}
          >
            {pushing ? strings.pushBranchStarting : strings.pushBranchStart}
          </button>
          <button
            type="button"
            className="sheet-option sheet-option--cancel"
            data-testid="push-branch-cancel"
            disabled={pushing}
            onClick={onDismiss}
          >
            {strings.pushBranchCancel}
          </button>
        </div>
      }
    >
      <div className="delivery-sheet">
        <p className="delivery-intro">{strings.pushBranchIntro}</p>
        {preview === undefined && failure === undefined && (
          <div className="state-card state-card--row">
            <Spinner label={strings.pushBranchPreviewLoading} />
            <p>{strings.pushBranchPreviewLoading}</p>
          </div>
        )}
        {failure !== undefined && (
          <p className="delivery-failed" data-testid="push-branch-preview-failed">
            {strings.pushBranchPreviewFailed} {failure}
          </p>
        )}
        {preview !== undefined && (
          <>
            <section className="delivery-section">
              <h3 className="delivery-section__title">{strings.pushBranchSourceLabel}</h3>
              <p className="delivery-worktree-line">
                <span className="delivery-worktree-line__name">{preview.source.worktreeName}</span>
                <span className="delivery-worktree-line__branch">{preview.source.branch}</span>
                <span className="delivery-worktree-line__sha">
                  {preview.source.head.slice(0, 8)}
                </span>
              </p>
              {preview.source.dirty && (
                <p className="delivery-note">
                  {strings.pushBranchDirty(
                    preview.source.changedFileCount,
                    preview.source.untrackedCount,
                  )}
                </p>
              )}
            </section>
            <section className="delivery-section">
              <h3 className="delivery-section__title">{strings.pushBranchRemoteLabel}</h3>
              <p className="delivery-note">
                {preview.remote.exists
                  ? strings.pushBranchExistingRemote(
                      preview.remote.name,
                      preview.remote.ahead,
                      preview.remote.behind,
                    )
                  : strings.pushBranchNewRemote(preview.remote.name)}
              </p>
              <div className="field">
                <label className="field__label" htmlFor="push-branch-remote-name">
                  {strings.pushBranchTargetLabel}
                </label>
                <input
                  id="push-branch-remote-name"
                  className="field__input"
                  data-testid="push-branch-remote-name"
                  value={remoteBranch}
                  disabled={pushing}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={255}
                  onChange={(event) => setRemoteBranch(event.currentTarget.value)}
                />
                <span className="field__hint">{strings.pushBranchTargetHint}</span>
              </div>
            </section>
            {blockers !== undefined && blockers.length > 0 && (
              <DeliveryErrorList errors={blockers} label={strings.pushBranchBlockers} />
            )}
          </>
        )}
      </div>
    </BottomSheet>
  )
}
