/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Composite trigger identity. A trigger id is only unique inside one workspace's
 *  `.universe-editor/triggers.json`, so every persisted record, queue entry and IPC
 *  argument uses the composite key instead of the bare id. The workspace identity is
 *  a URI string; path identity goes through the kernel helpers — never hand-rolled
 *  casing / separator folding.
 *--------------------------------------------------------------------------------------------*/

import {
  getPathComparisonKey,
  getResourceComparisonKey,
  normalizeFsPath,
  normalizePlatform,
  normalizeRemoteAuthority,
  REMOTE_SCHEME,
  URI,
  type HostPlatform,
} from '@universe-editor/platform'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'

/** NUL cannot appear in a folder path or a trigger id, so it is an unambiguous separator. */
const SEPARATOR = '\u0000'

/** A scheme is `scheme:` with at least two characters; single letters are Windows drives. */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]+:/

/**
 * Identity key for a workspace URI string.
 *
 * - `file:` folders use the host-platform path key (case / separators folded).
 * - `remote-ssh:` folders are compared against the *remote* filesystem: the path
 *   stays case-sensitive whatever the local platform, while the scheme and the
 *   authority are normalized by the kernel helpers.
 * - A bare absolute path is accepted because {@link canonicalTriggerKey} rebuilds
 *   keys from their already-normalized workspace part; a file key *is* a path.
 */
export function workspaceComparisonKey(
  workspace: string,
  platform: HostPlatform = normalizePlatform(process.platform),
): string {
  const value = workspace.trim()
  if (value.length === 0) return value
  if (!SCHEME_PREFIX.test(value)) return getPathComparisonKey(value, platform)
  const uri = parseWorkspaceUri(value) ?? URI.parse(value)
  const scheme = uri.scheme.toLowerCase()
  if (scheme === 'file') return getPathComparisonKey(uri.fsPath, platform)
  if (scheme === REMOTE_SCHEME) {
    const normalized = uri.with({
      scheme: REMOTE_SCHEME,
      authority: normalizeRemoteAuthority(uri.authority),
      path: normalizeFsPath(uri.path),
    })
    return getResourceComparisonKey(normalized, platform, () => true)
  }
  return uri.toString()
}

export function triggerKeyFor(
  workspace: string,
  triggerId: string,
  platform?: HostPlatform,
): string {
  return `${workspaceComparisonKey(workspace, platform)}${SEPARATOR}${triggerId}`
}

export interface ParsedTriggerKey {
  readonly workspaceKey: string
  readonly triggerId: string
}

export function parseTriggerKey(key: string): ParsedTriggerKey | undefined {
  const index = key.indexOf(SEPARATOR)
  if (index <= 0) return undefined
  const triggerId = key.slice(index + 1)
  if (triggerId.length === 0) return undefined
  return { workspaceKey: key.slice(0, index), triggerId }
}

/**
 * Rebuilds the key from its parsed parts. Entry points that accept an IPC key must
 * use this so every later state / queue read targets the same canonical spelling
 * even if a caller sends a differently-cased workspace key.
 */
export function canonicalTriggerKey(key: string): string | undefined {
  const parsed = parseTriggerKey(key)
  if (parsed === undefined) return undefined
  return `${workspaceComparisonKey(parsed.workspaceKey)}${SEPARATOR}${parsed.triggerId}`
}

/** True when `triggerKey` was built from `workspaceKey` (already normalized). */
export function triggerKeyBelongsToWorkspace(triggerKey: string, workspaceKey: string): boolean {
  return parseTriggerKey(triggerKey)?.workspaceKey === workspaceKey
}
