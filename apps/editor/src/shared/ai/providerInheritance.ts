/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for the `extends` relation between provider entries. Kept out of
 *  the view layer because both the card UI and its tests need them, and because
 *  "which ancestor actually supplied this value" is provider-model knowledge, not
 *  rendering knowledge.
 *
 *  Every walk here is cycle-guarded: aiSettings.json is hand-editable, so a loop
 *  is a state the UI must render, not a state it may hang on.
 *--------------------------------------------------------------------------------------------*/

import type { AiProtocolMap, AiProviderEntry, AiRemoteSourceSpec } from '@universe-editor/platform'

export interface InheritedValue<T> {
  /** Id of the nearest ancestor that declares the field. */
  readonly from: string
  readonly value: T
}

/** The nearest ancestor value for a field the entry itself leaves unset. */
export function findInherited<K extends keyof AiProviderEntry>(
  entry: AiProviderEntry,
  all: readonly AiProviderEntry[],
  field: K,
): InheritedValue<NonNullable<AiProviderEntry[K]>> | undefined {
  const byId = new Map(all.map((p) => [p.id, p]))
  const seen = new Set<string>([entry.id])
  let cur = entry.extends === undefined ? undefined : byId.get(entry.extends)
  while (cur !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id)
    const value = cur[field]
    if (value !== undefined) {
      return { from: cur.id, value: value as NonNullable<AiProviderEntry[K]> }
    }
    cur = cur.extends === undefined ? undefined : byId.get(cur.extends)
  }
  return undefined
}

/**
 * Ids `selfId` may point `extends` at. A cycle forms when the target already
 * reaches back to us, so the exclusion set is self plus every *descendant* —
 * the current chain above us is irrelevant, since setting a new target replaces it.
 */
export function computeExtendsCandidates(
  selfId: string,
  all: readonly AiProviderEntry[],
): readonly string[] {
  const byId = new Map(all.map((p) => [p.id, p]))
  const reachesSelf = (start: string): boolean => {
    const seen = new Set<string>([start])
    let cur = byId.get(start)?.extends
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === selfId) return true
      seen.add(cur)
      cur = byId.get(cur)?.extends
    }
    return false
  }
  return all.map((p) => p.id).filter((id) => id !== selfId && !reachesSelf(id))
}

export interface EffectiveConnection {
  readonly baseUrl?: string
  readonly apiKey?: string
}

/**
 * What a probe must actually dial. A purely inheriting entry (`{ id, extends }`)
 * carries neither address nor credential of its own, so probing its own fields
 * would hit the protocol's default endpoint unauthenticated and report a failure
 * the card has just told the user cannot happen.
 *
 * The returned `apiKey` is a plaintext secret belonging to an *ancestor*: it may
 * travel to main to open a connection and nowhere else. Never render it — an
 * inheriting card shows "Inherited from X", not the key.
 */
export function effectiveConnection(
  entry: AiProviderEntry,
  all: readonly AiProviderEntry[],
): EffectiveConnection {
  const baseUrl = entry.baseUrl ?? findInherited(entry, all, 'baseUrl')?.value
  const apiKey = entry.apiKey ?? findInherited(entry, all, 'apiKey')?.value
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}

export interface EffectiveSource {
  /** The spec that is actually in force — the entry's own, or the nearest ancestor's. */
  readonly value: AiRemoteSourceSpec
  /** Id of the entry that declares it. */
  readonly from: string
  /** True when the entry declares nothing of its own and the value came from `from`. */
  readonly inherited: boolean
}

/**
 * Which remote source a card must render, as opposed to which one it stores.
 * main resolves `extends` before it fetches (`flattenExtends` copies both source
 * fields down) and caches per resolved entry, so a purely inheriting entry *does*
 * have prices and usage of its own id. Reading only `entry[field]` would show
 * "None" over data that exists — the state this function exists to prevent.
 *
 * `inherited` is what separates rendering from writing: the form and the refresh
 * button follow the effective value, while every write still patches the entry's
 * own field so an edit never silently materializes an ancestor's config.
 */
export function effectiveRemoteSource(
  entry: AiProviderEntry,
  all: readonly AiProviderEntry[],
  field: 'pricingSource' | 'usageSource',
): EffectiveSource | undefined {
  const own = entry[field]
  if (own !== undefined) return { value: own, from: entry.id, inherited: false }
  const found = findInherited(entry, all, field)
  return found === undefined ? undefined : { value: found.value, from: found.from, inherited: true }
}

export function effectivePricingSource(
  entry: AiProviderEntry,
  all: readonly AiProviderEntry[],
): EffectiveSource | undefined {
  return effectiveRemoteSource(entry, all, 'pricingSource')
}

export function effectiveUsageSource(
  entry: AiProviderEntry,
  all: readonly AiProviderEntry[],
): EffectiveSource | undefined {
  return effectiveRemoteSource(entry, all, 'usageSource')
}

/**
 * The protocol map in force. Unlike the scalar fields this one is replaced
 * wholesale rather than merged, so "effective" is simply the nearest declaration.
 * Returns `{}` when nothing declares one — a provider that serves no models.
 */
export function effectiveProtocolMap(
  entry: AiProviderEntry,
  all: readonly AiProviderEntry[],
): AiProtocolMap {
  return entry.protocolMap ?? findInherited(entry, all, 'protocolMap')?.value ?? {}
}
