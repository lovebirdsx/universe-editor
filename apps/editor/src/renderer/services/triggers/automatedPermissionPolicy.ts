/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Permission policy for sessions started by an agent trigger. Automated
 *  sessions run unattended, so the user's personal auto-approval settings must
 *  not silently widen what a trigger can do (design §4). Pure helpers only:
 *  the session facade applies them at the permission sink.
 *--------------------------------------------------------------------------------------------*/

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

/** Structural subset of `IUriIdentityService`; path identity is never compared by hand. */
export interface AutomatedPathIdentity {
  relativePathUnder(parent: string, child: string): string | null
}

/** True when any path segment is `..` — a traversal attempt, not a runDir write. */
function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === '..')
}

/**
 * Only file writes are ever approved on the user's behalf, only for `edit`, and
 * only when the request names its targets. Reads omit locations (the fs gateway
 * enforces its own sandbox), location-less writes could touch arbitrary paths,
 * and `delete` / `move` are destructive regardless of where they point.
 */
export function decideAutomatedPermission(
  params: RequestPermissionRequest,
  runDir: string | undefined,
  pathIdentity: AutomatedPathIdentity,
): string | undefined {
  if (runDir === undefined) return undefined
  if (params.toolCall.kind !== 'edit') return undefined
  const locations = params.toolCall.locations ?? []
  if (locations.length === 0) return undefined
  if (locations.some((location) => hasParentSegment(location.path))) return undefined
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
