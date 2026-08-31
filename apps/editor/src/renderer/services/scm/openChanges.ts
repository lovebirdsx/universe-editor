/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Argument shapes the unified "Open Changes" command is invoked with. Each entry
 *  point passes something different: the Explorer context menu passes
 *  `{ resource, target, parent, isDirectory }`, the editor title toolbar passes
 *  `{ groupId }` (no resource — the active editor is the target), the dirty-diff
 *  peek passes a bare URI, and the keybinding passes nothing at all.
 *
 *  SCM row shapes (`{ resourceUri }`, a bare host fs-path) are deliberately NOT
 *  accepted: rows keep invoking their own provider's `<id>.openChange` directly,
 *  and turning a host path back into a URI would need remote-authority knowledge
 *  this pure function has no business holding.
 *--------------------------------------------------------------------------------------------*/

import { URI, type UriComponents } from '@universe-editor/platform'

/** The resource an Open Changes invocation targets, or undefined to fall back to
 *  the active editor. */
export function resolveOpenChangesTarget(arg: unknown): URI | undefined {
  if (arg instanceof URI) return arg
  if (arg === null || typeof arg !== 'object') return undefined
  const resource = (arg as { resource?: unknown }).resource
  if (resource instanceof URI) return resource
  if (resource === null || typeof resource !== 'object') return undefined
  // A URI that crossed a process boundary arrives as plain UriComponents. Require
  // a scheme: URI.revive happily builds a scheme-less URI from any object, which
  // would shadow the active-editor fallback with something unresolvable.
  if (typeof (resource as { scheme?: unknown }).scheme !== 'string') return undefined
  return URI.revive(resource as UriComponents) ?? undefined
}
