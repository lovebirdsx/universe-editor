import type {
  MobileDeliveryCommit,
  MobileDeliveryError,
  MobileDeliveryWorktreeResult,
} from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'

export function DeliveryCommitList({
  commits,
}: {
  readonly commits: readonly MobileDeliveryCommit[]
}) {
  if (commits.length === 0) {
    return <p className="delivery-empty">{strings.deliveryNoCommits}</p>
  }
  return (
    <ul className="delivery-commits" data-testid="delivery-commits">
      {commits.map((commit) => (
        <li key={commit.sha} className="delivery-commit">
          <span className="delivery-commit__sha">{commit.shortSha}</span>
          <span className="delivery-commit__subject">{commit.subject}</span>
        </li>
      ))}
    </ul>
  )
}

export function DeliveryErrorList({
  errors,
  label,
}: {
  readonly errors: readonly MobileDeliveryError[]
  readonly label?: string | undefined
}) {
  if (errors.length === 0) return null
  return (
    <section className="delivery-section">
      {label !== undefined && <h3 className="delivery-section__title">{label}</h3>}
      <ul className="delivery-errors" data-testid="delivery-errors">
        {errors.map((error) => (
          <li key={`${error.code}:${error.message}`} className="delivery-error">
            <span className="delivery-error__message">
              {error.code === 'push_unverified' ? strings.deliveryPushUnverified : error.message}
            </span>
            {error.detail !== undefined && error.detail !== '' && (
              <pre className="delivery-error__detail">{error.detail}</pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function DeliveryWorktreeResults({
  results,
}: {
  readonly results: readonly MobileDeliveryWorktreeResult[]
}) {
  if (results.length === 0) return null
  return (
    <section className="delivery-section">
      <h3 className="delivery-section__title">{strings.deliveryWorktreesLabel}</h3>
      <ul className="delivery-worktrees" data-testid="delivery-worktrees">
        {results.map((result) => (
          <li key={result.name} className="delivery-worktree">
            <span className="delivery-worktree__name">
              {result.name}
              {result.branch !== undefined && (
                <span className="delivery-worktree__branch"> ({result.branch})</span>
              )}
            </span>
            <span
              className={`delivery-worktree__status delivery-worktree__status--${result.status}`}
            >
              {strings.deliveryWorktreeStatusLabel(result.status)}
            </span>
            {result.error !== undefined && result.error !== '' && (
              <span className="delivery-worktree__error">{result.error}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
