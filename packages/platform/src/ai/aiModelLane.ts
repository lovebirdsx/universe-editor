/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Model-lane helpers. A trailing bracket suffix (`acme-chat-pro[1m]`,
 *  `kimi-k3[high]`) marks a lane of the same model — a context-window or effort
 *  variant — not a different model. The knowledge base is keyed by the bare
 *  model name (lane-invariant intrinsic properties), so a bare entry still
 *  applies to a lane-suffixed id. Exact match stays ahead: a user may key an
 *  entry by the suffixed id to pin knowledge onto that one lane, and that entry
 *  must keep winning over the bare-name fallback.
 *--------------------------------------------------------------------------------------------*/

import type { AiModelKnowledge } from './aiProviderEntry.js'

/**
 * Drop a trailing `[...]` lane suffix and nothing else — no casing, no date
 * snapshots. The suffix marks a lane of the same model, so a table keyed by the
 * bare name still applies, while a table that prices the lane separately must
 * keep winning on the exact key.
 */
export function stripModelLaneSuffix(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '')
}

export function lookupModelKnowledge(
  knowledge: Readonly<Record<string, AiModelKnowledge>>,
  key: string,
): AiModelKnowledge | undefined {
  const exact = knowledge[key]
  if (exact !== undefined) return exact
  const bare = stripModelLaneSuffix(key)
  return bare === key ? undefined : knowledge[bare]
}
