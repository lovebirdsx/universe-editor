import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'
import { summarizeDeliveries, type DeliveryInboxEntry } from './deliveryStatus.js'

export interface DeliverySummaryBarProps {
  readonly entries: readonly DeliveryInboxEntry[]
  readonly onOpenDelivery: (session: MobileSessionSummary) => void
}

/** Inbox-level roll-up; tapping opens the most actionable delivery. */
export function DeliverySummaryBar({ entries, onOpenDelivery }: DeliverySummaryBarProps) {
  const first = entries[0]
  if (first === undefined) return null
  const summary = summarizeDeliveries(entries)
  const activeLabel =
    summary.active === 0
      ? undefined
      : summary.active === 1 && summary.activePhase !== undefined
        ? strings.deliveryPhaseLabel(summary.activePhase)
        : strings.deliverySummaryActive(summary.active)
  const target =
    entries.find((entry) => entry.delivery.phase === 'awaiting_push') ??
    entries.find(
      (entry) => entry.delivery.phase === 'failed' || entry.delivery.phase === 'partial',
    ) ??
    first

  return (
    <button
      type="button"
      className="delivery-summary-bar"
      data-testid="inbox-delivery-summary"
      onClick={() => onOpenDelivery(target.session)}
    >
      <span className="delivery-summary-bar__title">
        {strings.deliverySummaryTitle(summary.total)}
      </span>
      <span className="delivery-summary-bar__detail">
        {activeLabel !== undefined && (
          <span
            className="delivery-summary-bar__pill delivery-summary-bar__pill--active"
            data-testid="inbox-delivery-summary-active"
          >
            {activeLabel}
          </span>
        )}
        {summary.pushable > 0 && (
          <span className="delivery-summary-bar__pill delivery-summary-bar__pill--action">
            {strings.deliverySummaryPushable(summary.pushable)}
          </span>
        )}
        {summary.failed > 0 && (
          <span className="delivery-summary-bar__pill delivery-summary-bar__pill--danger">
            {strings.deliverySummaryFailed(summary.failed)}
          </span>
        )}
      </span>
    </button>
  )
}
