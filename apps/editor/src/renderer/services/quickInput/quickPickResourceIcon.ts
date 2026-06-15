/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Encodes a resource URI into a quick-pick `iconId` string so the renderer can
 *  resolve it to a file-type icon (via FileIcon) — keeping the platform layer's
 *  iconId contract a plain string. Distinct from symbol-kind / header / agent ids.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'

export const QUICK_PICK_RESOURCE_ICON_PREFIX = 'resource:'
const DIRECTORY_MARKER = 'dir:'

export function resourceIconId(resource: URI, isDirectory = false): string {
  const marker = isDirectory ? DIRECTORY_MARKER : ''
  return QUICK_PICK_RESOURCE_ICON_PREFIX + marker + resource.toString()
}

export function parseResourceIconId(
  iconId: string,
): { resource: URI; isDirectory: boolean } | undefined {
  if (!iconId.startsWith(QUICK_PICK_RESOURCE_ICON_PREFIX)) return undefined
  let rest = iconId.slice(QUICK_PICK_RESOURCE_ICON_PREFIX.length)
  let isDirectory = false
  if (rest.startsWith(DIRECTORY_MARKER)) {
    isDirectory = true
    rest = rest.slice(DIRECTORY_MARKER.length)
  }
  return { resource: URI.parse(rest), isDirectory }
}
