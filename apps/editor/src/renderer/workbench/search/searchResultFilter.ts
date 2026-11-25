/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Search results must follow file deletions: a deleted file cannot match any
 *  more, so its matches are dropped immediately instead of waiting for a
 *  manual re-run. A directory delete may surface as a single event (fs.watch on
 *  out-of-workspace folders reports the folder, not each child), so matches
 *  nested under a deleted resource are dropped too.
 *--------------------------------------------------------------------------------------------*/

import {
  URI,
  type IFileChangeEvent,
  type IFileMatch,
  type IUriIdentityService,
} from '@universe-editor/platform'

/** Deleted resources of a watcher batch, revived for identity comparison. */
export function deletedResources(events: readonly IFileChangeEvent[]): URI[] {
  const deleted: URI[] = []
  for (const event of events) {
    if (event.type === 'deleted') deleted.push(URI.revive(event.resource) as URI)
  }
  return deleted
}

/** Whether `resource` was deleted itself or lived under a deleted directory. */
export function isDeletedResource(
  resource: URI,
  deleted: readonly URI[],
  uriIdentity: IUriIdentityService,
): boolean {
  if (deleted.length === 0) return false
  const target = URI.revive(resource) as URI
  return deleted.some((candidate) => uriIdentity.isEqualOrParent(target, candidate))
}

/**
 * Drop the results affected by `deleted`. Returns the input array unchanged when
 * nothing matched, so callers can cheaply skip a re-render.
 */
export function removeDeletedMatches(
  results: readonly IFileMatch[],
  deleted: readonly URI[],
  uriIdentity: IUriIdentityService,
): readonly IFileMatch[] {
  if (results.length === 0 || deleted.length === 0) return results
  const next = results.filter((fm) => !isDeletedResource(fm.resource, deleted, uriIdentity))
  return next.length === results.length ? results : next
}
