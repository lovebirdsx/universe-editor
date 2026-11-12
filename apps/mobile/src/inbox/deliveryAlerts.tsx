import type { MobileDeliveryPhase, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { useEffect, useRef } from 'react'
import type { MobileClient } from '../state/mobileClient.js'
import { useStore } from '../state/useStore.js'
import { ACTIVE_DELIVERY_PHASES, selectDeliveryEntries } from './deliveryStatus.js'

export type DeliveryAlertPhase = 'awaiting_push' | 'failed' | 'partial'

export interface DeliveryAlert {
  readonly deliveryId: string
  readonly phase: DeliveryAlertPhase
  readonly sessionTitle: string
}

const IN_PROGRESS_PHASES: ReadonlySet<MobileDeliveryPhase> = new Set([
  ...ACTIVE_DELIVERY_PHASES,
  'awaiting_push',
])

export interface DeliveryAlertScan {
  readonly next: ReadonlyMap<string, MobileDeliveryPhase>
  readonly alerts: readonly DeliveryAlert[]
}

/**
 * Compares delivery phases between inbox updates. The first scan only records
 * a baseline so a fresh snapshot never replays old state as a toast.
 */
export function scanDeliveryAlerts(
  previous: ReadonlyMap<string, MobileDeliveryPhase> | undefined,
  sessions: readonly MobileSessionSummary[],
): DeliveryAlertScan {
  const current = new Map<string, { phase: MobileDeliveryPhase; title: string }>()
  for (const entry of selectDeliveryEntries(sessions)) {
    current.set(entry.delivery.deliveryId, {
      phase: entry.delivery.phase,
      title: entry.session.title,
    })
  }
  const next = new Map<string, MobileDeliveryPhase>()
  for (const [deliveryId, entry] of current) next.set(deliveryId, entry.phase)
  if (previous === undefined) return { next, alerts: [] }

  const alerts: DeliveryAlert[] = []
  for (const [deliveryId, entry] of current) {
    const before = previous.get(deliveryId)
    if (before === undefined || before === entry.phase) continue
    if (!IN_PROGRESS_PHASES.has(before)) continue
    if (entry.phase !== 'awaiting_push' && entry.phase !== 'failed' && entry.phase !== 'partial') {
      continue
    }
    alerts.push({ deliveryId, phase: entry.phase, sessionTitle: entry.title })
  }
  return { next, alerts }
}

export function useDeliveryAlerts(
  client: MobileClient,
  enabled: boolean,
  onAlert: (alert: DeliveryAlert) => void,
): void {
  const inbox = useStore(client.getInboxStore())
  const previous = useRef<ReadonlyMap<string, MobileDeliveryPhase> | undefined>(undefined)
  const clientRef = useRef(client)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const onAlertRef = useRef(onAlert)
  onAlertRef.current = onAlert

  useEffect(() => {
    if (clientRef.current !== client) {
      clientRef.current = client
      previous.current = undefined
    }
    const result = scanDeliveryAlerts(previous.current, inbox.sessions)
    previous.current = result.next
    if (!enabledRef.current) return
    for (const alert of result.alerts) onAlertRef.current(alert)
  }, [client, inbox])
}

export interface DeliveryAlertWatcherProps {
  readonly client: MobileClient
  readonly enabled: boolean
  readonly onAlert: (alert: DeliveryAlert) => void
}

/** Invisible hook host so App keeps the inbox-phase bookkeeping out of its render. */
export function DeliveryAlertWatcher({
  client,
  enabled,
  onAlert,
}: DeliveryAlertWatcherProps): null {
  useDeliveryAlerts(client, enabled, onAlert)
  return null
}
