import { strings } from '../strings.js'

export interface PendingOption {
  readonly optionId: string
  readonly name: string
}

export interface PendingActionCardProps {
  readonly kind: 'permission' | 'elicitation'
  readonly title: string
  readonly message?: string | undefined
  readonly options?: readonly PendingOption[] | undefined
}

/**
 * Read-only approval / question card for M2. The grey option list shows what the
 * PC is asking; the empty `pending-card__actions` slot is where M3 mounts the
 * interactive buttons without changing this component's callers.
 */
export function PendingActionCard({ kind, title, message, options }: PendingActionCardProps) {
  return (
    <section
      className="pending-card"
      data-testid="pending-action-card"
      data-pending-kind={kind}
      aria-label={title}
    >
      <h2 className="pending-card__title">{title}</h2>
      {message !== undefined && message !== '' && (
        <p className="pending-card__message">{message}</p>
      )}
      {options !== undefined && options.length > 0 && (
        <div className="pending-card__options-group">
          <span className="pending-card__options-label">{strings.pendingOptionsLabel}</span>
          <ul className="pending-card__options">
            {options.map((option) => (
              <li key={option.optionId} className="pending-card__option">
                {option.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer className="pending-card__footer">
        <p className="pending-card__hint">{strings.pendingReadOnlyHint}</p>
        <div className="pending-card__actions" data-testid="pending-action-slot" />
      </footer>
    </section>
  )
}
