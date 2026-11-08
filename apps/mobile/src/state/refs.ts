import type { MobileSessionRef } from '@universe-editor/mobile-protocol'

/** Local identity: stable while a session lives, independent of `durableId`. */
export function localRefKey(ref: MobileSessionRef): string {
  return `${ref.windowId}:${ref.localId}`
}

/** URL identity: prefer the agent's durable session id once it has one. */
export function sessionRouteKey(ref: MobileSessionRef): string {
  return ref.durableId ?? localRefKey(ref)
}

/** Durable ids are authoritative; fall back to the window-local pair. */
export function refMatches(a: MobileSessionRef, b: MobileSessionRef): boolean {
  if (a.durableId !== undefined && b.durableId !== undefined) return a.durableId === b.durableId
  return a.windowId === b.windowId && a.localId === b.localId
}

/** Parse the `windowId:localId` half of a route key (durable ids have no shape). */
export function parseSessionRouteKey(key: string): MobileSessionRef | undefined {
  const colon = key.indexOf(':')
  if (colon <= 0) return undefined
  const windowIdText = key.slice(0, colon)
  if (!/^\d+$/.test(windowIdText)) return undefined
  const windowId = Number(windowIdText)
  if (!Number.isSafeInteger(windowId)) return undefined
  const localId = key.slice(colon + 1)
  if (localId === '') return undefined
  return { windowId, localId }
}
