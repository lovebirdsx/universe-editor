import type { MobileDeliverySummary, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { localRefKey } from '../state/refs.js'

/**
 * Delivery UI for a representative inbox row. Every PC window is one
 * workspace; its sessions share a single entry point and status badge so a
 * worktree with pending work does not offer the same delivery on every row.
 */
export interface InboxDeliveryOwnership {
  /** The representative's own `deliveryAvailable`; never aggregated from siblings. */
  readonly available: boolean
  /** The representative's own record, or the newest record in the same window. */
  readonly delivery?: MobileDeliverySummary
  /** Owner of `delivery`; delivery commands must use its ref. */
  readonly deliverySource?: MobileSessionSummary
}

interface SessionDelivery {
  readonly session: MobileSessionSummary
  readonly delivery: MobileDeliverySummary
}

/**
 * Input is the inbox list after `selectInboxSessions` (side tasks already
 * removed). The returned map only holds representative rows, keyed by
 * `localRefKey`; a missing key means "do not render delivery UI".
 */
export function selectInboxDeliveryOwnership(
  sessions: readonly MobileSessionSummary[],
): ReadonlyMap<string, InboxDeliveryOwnership> {
  const byWindow = new Map<number, MobileSessionSummary[]>()
  for (const session of sessions) {
    const group = byWindow.get(session.ref.windowId)
    if (group === undefined) byWindow.set(session.ref.windowId, [session])
    else group.push(session)
  }

  const ownership = new Map<string, InboxDeliveryOwnership>()
  for (const group of byWindow.values()) {
    const representative = selectRepresentative(group)
    if (representative === undefined) continue
    const record =
      representative.delivery !== undefined
        ? { session: representative, delivery: representative.delivery }
        : selectNewestDelivery(group)
    ownership.set(localRefKey(representative.ref), {
      available: representative.deliveryAvailable === true,
      ...(record !== undefined
        ? { delivery: record.delivery, deliverySource: record.session }
        : {}),
    })
  }
  return ownership
}

/** Prefer a running session, then the most recently updated one. */
function selectRepresentative(
  group: readonly MobileSessionSummary[],
): MobileSessionSummary | undefined {
  let running: MobileSessionSummary | undefined
  let latest: MobileSessionSummary | undefined
  for (const session of group) {
    const isRunning = session.bucket === 'in_progress'
    if (isRunning && (running === undefined || isMoreRecent(session, running))) {
      running = session
    }
    if (latest === undefined || isMoreRecent(session, latest)) latest = session
  }
  return running ?? latest
}

function isMoreRecent(candidate: MobileSessionSummary, current: MobileSessionSummary): boolean {
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt
  return candidate.ref.localId < current.ref.localId
}

function selectNewestDelivery(group: readonly MobileSessionSummary[]): SessionDelivery | undefined {
  let newest: SessionDelivery | undefined
  for (const session of group) {
    const delivery = session.delivery
    if (delivery === undefined) continue
    if (newest === undefined || isNewerDelivery(session, delivery, newest)) {
      newest = { session, delivery }
    }
  }
  return newest
}

function isNewerDelivery(
  session: MobileSessionSummary,
  delivery: MobileDeliverySummary,
  current: SessionDelivery,
): boolean {
  if (delivery.updatedAt !== current.delivery.updatedAt) {
    return delivery.updatedAt > current.delivery.updatedAt
  }
  return localRefKey(session.ref) < localRefKey(current.session.ref)
}
