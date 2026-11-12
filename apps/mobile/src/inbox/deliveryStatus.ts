import type {
  MobileDeliveryPhase,
  MobileDeliverySummary,
  MobileSessionSummary,
} from '@universe-editor/mobile-protocol'

/** Phases that mean the PC is still working; prompts / new sessions wait. */
export const ACTIVE_DELIVERY_PHASES: ReadonlySet<MobileDeliveryPhase> = new Set([
  'preflighting',
  'committing',
  'cherry_picking',
  'resolving_conflict',
  'pushing',
  'syncing',
  'undoing',
])

/** Phases worth surfacing in the inbox: running, waiting for the user, or broken. */
const RELEVANT_DELIVERY_PHASES: ReadonlySet<MobileDeliveryPhase> = new Set([
  ...ACTIVE_DELIVERY_PHASES,
  'awaiting_push',
  'partial',
  'failed',
])

export interface DeliveryInboxEntry {
  readonly session: MobileSessionSummary
  readonly delivery: MobileDeliverySummary
}

export type DeliveryTone = 'active' | 'action' | 'ok' | 'warning' | 'danger'

export function isActiveDeliveryPhase(phase: MobileDeliveryPhase): boolean {
  return ACTIVE_DELIVERY_PHASES.has(phase)
}

export function deliveryTone(phase: MobileDeliveryPhase): DeliveryTone {
  switch (phase) {
    case 'awaiting_push':
      return 'action'
    case 'synced':
    case 'undone':
      return 'ok'
    case 'partial':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'resolving_conflict':
      return 'warning'
    default:
      return 'active'
  }
}

/**
 * One delivery row per delivery id. The inbox can briefly hold the same
 * delivery on two rows (source + a resumed durable row); the summary bar must
 * not double-count it.
 */
export function selectDeliveryEntries(
  sessions: readonly MobileSessionSummary[],
  visibleOnly = false,
): readonly DeliveryInboxEntry[] {
  const seen = new Set<string>()
  const entries: DeliveryInboxEntry[] = []
  for (const session of sessions) {
    const delivery = session.delivery
    if (delivery === undefined) continue
    if (visibleOnly && !RELEVANT_DELIVERY_PHASES.has(delivery.phase)) continue
    if (seen.has(delivery.deliveryId)) continue
    seen.add(delivery.deliveryId)
    entries.push({ session, delivery })
  }
  return entries
}

export interface DeliveryInboxSummary {
  readonly total: number
  readonly active: number
  readonly activePhase?: MobileDeliveryPhase
  readonly pushable: number
  readonly failed: number
}

export function summarizeDeliveries(entries: readonly DeliveryInboxEntry[]): DeliveryInboxSummary {
  let active = 0
  let activePhase: MobileDeliveryPhase | undefined
  let pushable = 0
  let failed = 0
  for (const entry of entries) {
    if (isActiveDeliveryPhase(entry.delivery.phase)) {
      active += 1
      activePhase ??= entry.delivery.phase
    }
    if (entry.delivery.phase === 'awaiting_push') pushable += 1
    if (entry.delivery.phase === 'failed' || entry.delivery.phase === 'partial') failed += 1
  }
  return {
    total: entries.length,
    active,
    ...(activePhase !== undefined ? { activePhase } : {}),
    pushable,
    failed,
  }
}
