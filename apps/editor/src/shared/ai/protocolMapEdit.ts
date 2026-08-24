/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure editing helpers for `AiProviderEntry.protocolMap`. The map has three
 *  states per protocol — key absent (not spoken), `[]` (enumerate from the
 *  endpoint), non-empty array (this exact list, never touching the network) —
 *  and every UI mutation below preserves that grammar rather than inventing a
 *  fourth state.
 *
 *  The other job here is normalisation: `AiProtocolModelRef` is a string *or* an
 *  override object, and the string form is not merely shorthand — it is what the
 *  file should contain whenever the object would carry nothing beyond the name.
 *  Round-tripping a model through the editor must not turn `"gpt-4o"` into
 *  `{ "id": "gpt-4o" }`.
 *--------------------------------------------------------------------------------------------*/

import type {
  AiModelCapabilities,
  AiProtocolMap,
  AiProtocolModelOverride,
  AiProtocolModelRef,
  AiWireProtocol,
} from '@universe-editor/platform'

export const AI_CAPABILITY_KEYS = ['streaming', 'vision', 'promptCaching', 'toolCalling'] as const
export type AiCapabilityKey = (typeof AI_CAPABILITY_KEYS)[number]

/** Wire name the endpoint expects for this ref. */
export function refWireName(ref: AiProtocolModelRef): string {
  if (typeof ref === 'string') return ref
  return ref.id ?? ref.ref ?? ''
}

/** Knowledge-base key this ref resolves metadata against. */
export function refKnowledgeKey(ref: AiProtocolModelRef): string {
  if (typeof ref === 'string') return ref
  return ref.ref ?? ref.id ?? ''
}

/** The form-editable slice of a ref; `rest` carries fields the form does not expose. */
export interface ModelRefDraft {
  readonly id: string
  readonly ref: string
  /** Capabilities explicitly turned off for this channel. */
  readonly disabled: readonly AiCapabilityKey[]
  readonly rest: Readonly<Record<string, unknown>>
}

export function draftFromRef(value: AiProtocolModelRef): ModelRefDraft {
  if (typeof value === 'string') return { id: value, ref: '', disabled: [], rest: {} }
  const { id, ref, capabilities, ...rest } = value
  return {
    id: id ?? '',
    ref: ref ?? '',
    disabled: AI_CAPABILITY_KEYS.filter((key) => capabilities?.[key] === false),
    rest: rest as Readonly<Record<string, unknown>>,
  }
}

/**
 * Collapse a draft back to the simplest representation that means the same
 * thing. Returns undefined when the draft names no model at all.
 */
export function refFromDraft(draft: ModelRefDraft): AiProtocolModelRef | undefined {
  const id = draft.id.trim()
  const ref = draft.ref.trim()
  const wire = id !== '' ? id : ref
  const key = ref !== '' ? ref : id
  if (wire === '') return undefined
  if (wire === key && draft.disabled.length === 0 && Object.keys(draft.rest).length === 0) {
    return wire
  }
  const capabilities: Record<string, boolean> = {}
  for (const cap of draft.disabled) capabilities[cap] = false
  return {
    ...draft.rest,
    ...(id !== '' ? { id } : {}),
    ...(ref !== '' ? { ref } : {}),
    ...(draft.disabled.length > 0
      ? { capabilities: capabilities as unknown as AiModelCapabilities }
      : {}),
  } as AiProtocolModelOverride
}

export function declaredProtocols(map: AiProtocolMap | undefined): readonly AiWireProtocol[] {
  return (Object.keys(map ?? {}) as AiWireProtocol[]).sort()
}

/**
 * Render order for the protocol blocks: explicit static lists first, then
 * "discover from endpoint" (`[]`) entries, each group in `declaredProtocols`
 * order. Display-only — `declaredProtocols` keeps its own order, which
 * `useAutoVerify` relies on for the default-protocol fallback.
 */
export function staticFirstProtocols(map: AiProtocolMap | undefined): readonly AiWireProtocol[] {
  const declared = declaredProtocols(map)
  const refs = map ?? {}
  return [
    ...declared.filter((p) => (refs[p] ?? []).length > 0),
    ...declared.filter((p) => (refs[p] ?? []).length === 0),
  ]
}

export function setProtocolRefs(
  map: AiProtocolMap | undefined,
  protocol: AiWireProtocol,
  refs: readonly AiProtocolModelRef[],
): AiProtocolMap {
  return { ...map, [protocol]: refs }
}

export function removeProtocol(
  map: AiProtocolMap | undefined,
  protocol: AiWireProtocol,
): AiProtocolMap {
  const next: Partial<Record<AiWireProtocol, readonly AiProtocolModelRef[]>> = { ...map }
  delete next[protocol]
  return next
}

/** Append names that are not already declared, preserving the existing order. */
export function appendModelNames(
  refs: readonly AiProtocolModelRef[],
  names: readonly string[],
): readonly AiProtocolModelRef[] {
  const seen = new Set(refs.map(refWireName))
  const added: AiProtocolModelRef[] = []
  for (const name of names) {
    const trimmed = name.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    added.push(trimmed)
  }
  return added.length === 0 ? refs : [...refs, ...added]
}

/**
 * Fold a probe dialog's checkbox state back into the declared list.
 *
 * The dialog only ever showed `offered`, so a checkbox is an answer about those
 * names and nothing else. Two kinds of existing entry must therefore survive it:
 * a ref the endpoint no longer lists (the user was never given a box to keep it
 * ticked), and the object form of a ref that *was* offered — its `ref` binding
 * and narrowed capabilities are hand-authored knowledge a wire name cannot carry.
 */
export function mergeProbedSelection(
  existing: readonly AiProtocolModelRef[],
  offered: readonly string[],
  selected: readonly string[],
): readonly AiProtocolModelRef[] {
  const offeredSet = new Set(offered)
  const selectedSet = new Set(selected)
  const kept = existing.filter((ref) => {
    const wire = refWireName(ref)
    return offeredSet.has(wire) ? selectedSet.has(wire) : true
  })
  return appendModelNames(kept, selected)
}
