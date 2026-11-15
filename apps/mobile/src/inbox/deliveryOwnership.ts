import type { MobileDeliverySummary, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { localRefKey } from '../state/refs.js'
import { isDeliveryInFlight, selectDeliveryEntries } from './deliveryStatus.js'

/**
 * Delivery UI for one inbox row. A status badge stays on the session that owns
 * the record; the start entry is collapsed to one representative row per PC
 * window (= workspace) so pending work is not offered on every row.
 */
export interface InboxDeliveryRow {
  /** The row's own record; never borrowed from another session. */
  readonly delivery?: MobileDeliverySummary
  /** Representative row with its own pending work and no record of its own. */
  readonly canStart: boolean
  /** Would be `canStart`, but another session in the window holds the delivery lock. */
  readonly busyInWorkspace: boolean
}

/**
 * Input is the inbox list after `selectInboxSessions` (side tasks already
 * removed). Keyed by `localRefKey`; a missing key means "no delivery UI".
 * `isStarting` marks rows whose startDelivery is in flight on the phone.
 */
export function selectInboxDeliveryRows(
  sessions: readonly MobileSessionSummary[],
  isStarting?: (session: MobileSessionSummary) => boolean,
): ReadonlyMap<string, InboxDeliveryRow> {
  const rows = new Map<string, InboxDeliveryRow>()
  // Same owner per deliveryId as the summary bar and the alerts.
  for (const entry of selectDeliveryEntries(sessions)) {
    rows.set(localRefKey(entry.session.ref), {
      delivery: entry.delivery,
      canStart: false,
      busyInWorkspace: false,
    })
  }

  const byWindow = new Map<number, MobileSessionSummary[]>()
  for (const session of sessions) {
    const group = byWindow.get(session.ref.windowId)
    if (group === undefined) byWindow.set(session.ref.windowId, [session])
    else group.push(session)
  }

  for (const group of byWindow.values()) {
    const representative = selectRepresentative(group)
    if (representative === undefined) continue
    if (representative.deliveryAvailable !== true || representative.delivery !== undefined) continue
    const busy = group.some(
      (session) =>
        session !== representative &&
        ((session.delivery !== undefined && isDeliveryInFlight(session.delivery.phase)) ||
          isStarting?.(session) === true),
    )
    rows.set(localRefKey(representative.ref), { canStart: !busy, busyInWorkspace: busy })
  }
  return rows
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
