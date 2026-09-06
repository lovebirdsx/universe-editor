/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The one `renderIcon` every context menu takes. `workbench-ui` deliberately
 *  owns no icon library — its menus render a leading slot only when the host
 *  supplies this callback — so this is the single place the workbench's icon
 *  tables get injected. Passing it from every menu host (rather than letting
 *  each write its own) is what keeps glyph, size and stroke identical across
 *  the Explorer, editor, SCM, graph and agent menus.
 *
 *  Agent logos are chained in so a row carrying an agent's id (the ids the ACP
 *  registry hands out) resolves too — via the *strict* resolver, so an unrelated
 *  id falls through to "no icon" instead of picking up the generic bot fallback.
 *--------------------------------------------------------------------------------------------*/

import { resolveKnownAgentIcon } from '../agents/agentIcon.js'
import { resolveIcon } from './icon-map.js'

/** Menu glyph metrics, matched to the SCM row buttons they sit beside. */
const SIZE = 16
const STROKE = 1.6

export function renderMenuIcon(icon: string | undefined) {
  const Glyph = resolveIcon(icon)
  if (Glyph) return <Glyph size={SIZE} strokeWidth={STROKE} />
  const AgentGlyph = resolveKnownAgentIcon(icon)
  return AgentGlyph ? <AgentGlyph size={SIZE} /> : null
}
