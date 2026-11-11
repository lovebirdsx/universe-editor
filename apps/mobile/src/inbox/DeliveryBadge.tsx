import type { KeyboardEvent } from 'react'
import type { MobileDeliverySummary } from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'
import { deliveryTone } from './deliveryStatus.js'

export interface SessionDeliveryControlsProps {
  readonly delivery?: MobileDeliverySummary | undefined
  /** The row can start a first delivery; synced rows re-deliver from the detail sheet. */
  readonly available?: boolean | undefined
  readonly onStartDelivery: () => void
  readonly onOpenDelivery: () => void
}

function activate(event: KeyboardEvent<HTMLSpanElement>, action: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.stopPropagation()
  action()
}

/**
 * Rendered inside the session row `<button>`; interactive children are spans
 * with `role="button"` (never nested buttons) and stop the click from opening
 * the session.
 */
export function SessionDeliveryControls({
  delivery,
  available,
  onStartDelivery,
  onOpenDelivery,
}: SessionDeliveryControlsProps) {
  // A synced row keeps only the status badge: re-delivery lives in the detail
  // sheet, so the row never offers a preview that would immediately block.
  const canStart = available === true && delivery?.phase !== 'synced'
  if (delivery === undefined && !canStart) return null

  return (
    <>
      {delivery !== undefined && (
        <span
          role="button"
          tabIndex={0}
          className={`delivery-badge delivery-badge--${deliveryTone(delivery.phase)}`}
          data-testid="inbox-delivery-badge"
          aria-label={`${strings.deliveryAction}：${strings.deliveryPhaseLabel(delivery.phase)}`}
          onClick={(event) => {
            event.stopPropagation()
            onOpenDelivery()
          }}
          onKeyDown={(event) => activate(event, onOpenDelivery)}
        >
          {strings.deliveryPhaseLabel(delivery.phase)}
        </span>
      )}
      {canStart && (
        <span
          role="button"
          tabIndex={0}
          className="session-badge session-badge--action"
          data-testid="inbox-delivery-action"
          onClick={(event) => {
            event.stopPropagation()
            onStartDelivery()
          }}
          onKeyDown={(event) => activate(event, onStartDelivery)}
        >
          {strings.deliveryAction}
        </span>
      )}
    </>
  )
}
