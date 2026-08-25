/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for tracking who references a model-knowledge key. A protocolMap
 *  ref points at a knowledge key either explicitly (`ref`) or implicitly — the
 *  string shorthand and a bare object id ARE the wire name the endpoint expects —
 *  so a knowledge rename can only rewrite the explicit form. These helpers answer
 *  the two questions a rename must ask: who is affected, and which of them can be
 *  fixed automatically.
 *--------------------------------------------------------------------------------------------*/

import type {
  AiProtocolModelOverride,
  AiProtocolModelRef,
  AiProviderEntry,
  AiWireProtocol,
} from '@universe-editor/platform'

import { refKnowledgeKey } from './protocolMapEdit.js'

export interface KnowledgeReference {
  readonly providerId: string
  /** At least one object ref carries an explicit `ref` — a rename can rewrite those. */
  readonly explicit: boolean
  /**
   * At least one reference carries no explicit `ref`: its knowledge key IS the wire
   * name the endpoint expects. Renaming the knowledge key cannot be propagated
   * there — doing so would rename the wire model and break the call.
   */
  readonly bare: boolean
}

/**
 * Every provider entry whose protocolMap references this knowledge key. The two
 * flags are independent, not exclusive: a provider mixing both forms is reported
 * as both, because it is genuinely both — part of it follows the rename and part
 * of it silently degrades, and a rename confirmation that mentioned only the
 * rewritable half would hide the loss.
 */
export function referencingProviders(
  providers: readonly AiProviderEntry[],
  key: string,
): readonly KnowledgeReference[] {
  const found: KnowledgeReference[] = []
  for (const provider of providers) {
    const map = provider.protocolMap
    if (map === undefined) continue
    let explicit = false
    let bare = false
    for (const refs of Object.values(map)) {
      if (refs === undefined) continue
      for (const ref of refs) {
        if (refKnowledgeKey(ref) !== key) continue
        if (hasExplicitRef(ref)) explicit = true
        else bare = true
      }
    }
    if (!explicit && !bare) continue
    found.push({ providerId: provider.id, explicit, bare })
  }
  return found
}

/** True for object refs with an explicit `ref` — the only form a rename may rewrite. */
function hasExplicitRef(
  ref: AiProtocolModelRef,
): ref is AiProtocolModelOverride & { readonly ref: string } {
  return typeof ref !== 'string' && ref.ref !== undefined
}

export interface RenameRewrite {
  readonly providers: readonly AiProviderEntry[]
  /** Object refs with an explicit `ref` — safely rewritten. */
  readonly explicitRefCount: number
  /** String shorthands and bare object ids — left alone, they are wire names. */
  readonly bareRefCount: number
}

/** Rewrite only explicit `ref` fields; string shorthands are wire names and stay. */
export function rewriteRefsForRename(
  providers: readonly AiProviderEntry[],
  oldKey: string,
  newKey: string,
): RenameRewrite {
  let explicitRefCount = 0
  let bareRefCount = 0
  let anyChanged = false
  const rewriteRef = (ref: AiProtocolModelRef): AiProtocolModelRef | undefined => {
    if (refKnowledgeKey(ref) !== oldKey) return undefined
    if (!hasExplicitRef(ref)) {
      bareRefCount++
      return undefined
    }
    explicitRefCount++
    return { ...ref, ref: newKey }
  }
  const rewritten: AiProviderEntry[] = providers.map((provider) => {
    const map = provider.protocolMap
    if (map === undefined) return provider
    let mapChanged = false
    const nextMap: Partial<Record<AiWireProtocol, readonly AiProtocolModelRef[]>> = {}
    for (const [protocol, refs] of Object.entries(map)) {
      if (refs === undefined) continue
      const nextRefs: AiProtocolModelRef[] = []
      let refsChanged = false
      for (const ref of refs) {
        const nextRef = rewriteRef(ref)
        if (nextRef === undefined) {
          nextRefs.push(ref)
        } else {
          nextRefs.push(nextRef)
          refsChanged = true
        }
      }
      if (refsChanged) {
        nextMap[protocol as AiWireProtocol] = nextRefs
        mapChanged = true
      } else {
        nextMap[protocol as AiWireProtocol] = refs
      }
    }
    if (!mapChanged) return provider
    anyChanged = true
    return { ...provider, protocolMap: nextMap }
  })
  return {
    providers: anyChanged ? rewritten : providers,
    explicitRefCount,
    bareRefCount,
  }
}
