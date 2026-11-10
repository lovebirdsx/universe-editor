/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared rules for the resumable-history catalog. The renderer bridge applies
 *  them to its in-memory mirror; main applies the same rules when it reads a
 *  closed workspace's persisted bucket.
 *--------------------------------------------------------------------------------------------*/

export const ACP_SESSION_HISTORY_STORAGE_KEY = 'acp.sessionHistory'
export const ACP_SESSION_HISTORY_SCHEMA_VERSION = 6
/** Old payloads stay readable: no field added since v1 requires migration. */
export const ACP_SESSION_HISTORY_ACCEPTED_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6]

/** The minimum persisted shape the catalog filter needs. */
export interface ResumableHistoryEntry {
  readonly id: string
  readonly cwd?: string
  readonly authority?: string
  readonly sideTaskOf?: string
  readonly archived?: boolean
  readonly hasMessages?: boolean
}

/** Structural subset of `IUriIdentityService` so main can pass the same rules. */
export interface HistoryPathIdentity {
  relativePathUnder(parent: string, child: string): string | null
}

/** True when `child` equals `parent` or resolves beneath it. */
export function isDescendantOrEqualPath(
  pathIdentity: HistoryPathIdentity,
  parent: string | undefined,
  child: string | undefined,
): boolean {
  if (parent === undefined || child === undefined) return false
  return pathIdentity.relativePathUnder(parent, child) !== null
}

/**
 * Whether a history entry belongs to a different workspace than the bucket
 * being read. Same relation the renderer uses for its split-brain guard: a
 * subdirectory is part of the workspace, and an entry with no cwd cannot be
 * proven foreign.
 */
export function isForeignWorkspaceHistoryEntry(
  entry: Pick<ResumableHistoryEntry, 'cwd' | 'authority'>,
  currentCwd: string | undefined,
  currentAuthority: string | undefined,
  pathIdentity: HistoryPathIdentity,
): boolean {
  if (entry.cwd === undefined || currentCwd === undefined) return false
  if (!isDescendantOrEqualPath(pathIdentity, currentCwd, entry.cwd)) return true
  // Past this point the cwd lies inside the bucket's folder, so a legacy row
  // that predates persisted authorities belongs to this host.
  return entry.authority !== undefined && entry.authority !== currentAuthority
}

/**
 * Rows the phone may resume: side tasks have their own entry point, archived
 * rows are hidden on the PC, an agent never persisted a session without a
 * message, and cross-workspace rows must not leak into this bucket's catalog.
 */
export function isResumableHistoryEntry(
  entry: ResumableHistoryEntry,
  currentCwd: string | undefined,
  currentAuthority: string | undefined,
  pathIdentity: HistoryPathIdentity,
): boolean {
  if (entry.sideTaskOf !== undefined) return false
  if (entry.archived === true) return false
  if (entry.hasMessages === false) return false
  if (entry.id.length === 0) return false
  return !isForeignWorkspaceHistoryEntry(entry, currentCwd, currentAuthority, pathIdentity)
}
