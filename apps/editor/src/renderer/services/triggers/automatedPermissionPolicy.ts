/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Permission policy for sessions started by an agent trigger. Automated
 *  sessions run unattended, so the user's personal auto-approval settings must
 *  not silently widen what a trigger can do (design §4). Pure helpers only:
 *  the session facade applies them at the permission sink.
 *--------------------------------------------------------------------------------------------*/

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { fsPathToWorkspaceUri, relativePathUnder, type URI } from '@universe-editor/platform'

/** Structural subset of `IUriIdentityService`; path identity is never compared by hand. */
export interface AutomatedPathIdentity {
  relativePathUnder(parent: string, child: string): string | null
}

/** True when any path segment is `..` — a traversal attempt, not a runDir write. */
function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === '..')
}

/**
 * Run-dir containment by resource URI. A remote path belongs to another host's
 * filesystem, so the client's platform case policy must not decide whether two
 * of its paths are the same resource: remote resources are compared
 * case-sensitively (POSIX), local ones with the injected platform policy.
 */
function isUnderRunDir(runDir: URI, target: URI, pathIdentity: AutomatedPathIdentity): boolean {
  if (runDir.scheme !== target.scheme || runDir.authority !== target.authority) return false
  if (runDir.scheme === 'file') {
    return pathIdentity.relativePathUnder(runDir.path, target.path) !== null
  }
  return relativePathUnder(runDir.path, target.path, 'linux') !== null
}

/**
 * Only file writes are ever approved on the user's behalf, only for `edit`, and
 * only when the request names its targets. Reads omit locations (the fs gateway
 * enforces its own sandbox), location-less writes could touch arbitrary paths,
 * and `delete` / `move` are destructive regardless of where they point.
 *
 * `runDir` / location paths are host-native: on a remote workspace they are
 * paths on that host, so both sides are lifted to the workspace's authority
 * before any comparison.
 */
export function decideAutomatedPermission(
  params: RequestPermissionRequest,
  runDir: string | undefined,
  authority: string | undefined,
  pathIdentity: AutomatedPathIdentity,
): string | undefined {
  if (runDir === undefined) return undefined
  if (params.toolCall.kind !== 'edit') return undefined
  const locations = params.toolCall.locations ?? []
  if (locations.length === 0) return undefined
  if (locations.some((location) => hasParentSegment(location.path))) return undefined
  const runDirUri = fsPathToWorkspaceUri(runDir, authority)
  const allInsideRunDir = locations.every((location) =>
    isUnderRunDir(runDirUri, fsPathToWorkspaceUri(location.path, authority), pathIdentity),
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
