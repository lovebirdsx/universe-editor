/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Composite trigger identity. A trigger id is only unique inside one workspace's
 *  `.universe-editor/triggers.json`, so every persisted record, queue entry and IPC
 *  argument uses the composite key instead of the bare id. Path identity goes through
 *  the kernel helpers — never hand-rolled casing / separator folding.
 *--------------------------------------------------------------------------------------------*/

import {
  getPathComparisonKey,
  normalizePlatform,
  type HostPlatform,
} from '@universe-editor/platform'

/** NUL cannot appear in a folder path or a trigger id, so it is an unambiguous separator. */
const SEPARATOR = '\u0000'

export function workspaceComparisonKey(
  workspace: string,
  platform: HostPlatform = normalizePlatform(process.platform),
): string {
  return getPathComparisonKey(workspace, platform)
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
