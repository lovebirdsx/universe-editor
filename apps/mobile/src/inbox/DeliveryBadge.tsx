import type { KeyboardEvent } from 'react'
import type { MobileDeliverySummary } from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'
import { deliveryPhaseText, deliveryTone } from './deliveryStatus.js'

export interface SessionDeliveryControlsProps {
  readonly delivery?: MobileDeliverySummary | undefined
  /** The row can start a first delivery; existing records open the detail sheet. */
  readonly available?: boolean | undefined
  /** The phone fired startDelivery and the inbox has not mirrored the record yet. */
  readonly starting?: boolean | undefined
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
  starting,
  onStartDelivery,
  onOpenDelivery,
}: SessionDeliveryControlsProps) {
  if (delivery === undefined && starting === true) {
    return (
      <span
        className="delivery-badge delivery-badge--active"
        data-testid="inbox-delivery-starting"
        role="status"
      >
        {strings.deliveryStarting}
      </span>
    )
  }
  // Any existing record (running, awaiting push, failed, synced, undone) opens
  // the detail sheet; only a row with no record at all gets the start action.
  const canStart = available === true && delivery === undefined
  if (delivery === undefined && !canStart) return null

  return (
    <>
      {delivery !== undefined && (
        <span
          role="button"
          tabIndex={0}
          className={`delivery-badge delivery-badge--${deliveryTone(delivery.phase)}`}
          data-testid="inbox-delivery-badge"
          aria-label={`${strings.deliveryAction}：${deliveryPhaseText(delivery)}`}
          onClick={(event) => {
            event.stopPropagation()
            onOpenDelivery()
          }}
          onKeyDown={(event) => activate(event, onOpenDelivery)}
        >
          {deliveryPhaseText(delivery)}
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
