/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Permission policy for sessions started by an agent trigger. Automated
 *  sessions run unattended, so the user's personal auto-approval settings must
 *  not silently widen what a trigger can do (design §4). Pure helpers only:
 *  the session facade applies them at the permission sink.
 *--------------------------------------------------------------------------------------------*/

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { ELEVATED_MODE_IDS } from '../../../shared/triggers/types.js'

/** Structural subset of `IUriIdentityService`; path identity is never compared by hand. */
export interface AutomatedPathIdentity {
  relativePathUnder(parent: string, child: string): string | null
}

/**
 * Only file writes are ever approved on the user's behalf, and only when the
 * request names its targets. Reads omit locations (the fs gateway enforces its
 * own sandbox), and location-less writes could touch arbitrary paths.
 */
const AUTOMATED_WRITE_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move'])

/** True for the bypass-class mode ids a trigger may use only after confirmation. */
export function isElevatedModeId(mode: string | undefined): boolean {
  return mode !== undefined && ELEVATED_MODE_IDS.includes(mode)
}

/**
 * The option an automated session may select without asking: a one-shot
 * `allow_once` when every location of the request lies inside `runDir`. Never
 * `allow_always` — that would persist a rule onto the user's real agent
 * defaults and affect every later (manual) session.
 */
export function decideAutomatedPermission(
  params: RequestPermissionRequest,
  runDir: string | undefined,
  pathIdentity: AutomatedPathIdentity,
): string | undefined {
  if (runDir === undefined) return undefined
  const kind = params.toolCall.kind
  if (kind == null || !AUTOMATED_WRITE_KINDS.has(kind)) return undefined
  const locations = params.toolCall.locations ?? []
  if (locations.length === 0) return undefined
  const allInsideRunDir = locations.every(
    (location) => pathIdentity.relativePathUnder(runDir, location.path) !== null,
  )
  if (!allInsideRunDir) return undefined
  return params.options.find((option) => option.kind === 'allow_once')?.optionId
}

/**
 * The options an automated session's permission card may offer. `allow_always`
 * entries are hidden: choosing one would call `persistAllow` and leak a durable
 * rule into the user's `acp.permissions.autoApprove` memory layer.
 */
export function visibleAutomatedPermissionOptions<T extends { readonly kind?: string }>(
  options: readonly T[],
): readonly T[] {
  return options.filter((option) => option.kind !== 'allow_always')
}
