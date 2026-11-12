/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure resolution rules for `acp.projectRoots`, shared by the renderer scope
 *  picker and the main-process mobile gateway (which cannot use the renderer's
 *  IConfigurationService).
 *--------------------------------------------------------------------------------------------*/

import {
  fsPathToWorkspaceUri,
  isAbsolutePath,
  URI,
  type HostPlatform,
} from '@universe-editor/platform'

export const PROJECT_ROOTS_KEY = 'acp.projectRoots'

/** Same filtering the renderer applies: non-empty strings, value untouched. */
export function configuredProjectRootEntries(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  )
}

/**
 * Resolve one configured entry against the workspace root. Absolute entries are
 * host paths on the workspace's machine; relative entries are joined onto the
 * root. `..` is left to URI.joinPath and must be rejected by callers that need
 * containment (the mobile gateway does; the desktop picker reports foreign
 * roots instead).
 */
export function resolveConfiguredProjectRoot(
  root: URI,
  entry: string,
  platform: HostPlatform,
): URI {
  if (isAbsolutePath(entry, platform)) {
    return fsPathToWorkspaceUri(entry, root.authority || undefined)
  }
  const segments = entry.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== '.')
  return URI.joinPath(root, ...segments)
}
