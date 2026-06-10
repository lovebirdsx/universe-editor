/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Encodes a resource URI into a quick-pick `iconId` string so the renderer can
 *  resolve it to a file-type icon (via FileIcon) — keeping the platform layer's
 *  iconId contract a plain string. Distinct from symbol-kind / header / agent ids.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'

export const QUICK_PICK_RESOURCE_ICON_PREFIX = 'resource:'

export function resourceIconId(resource: URI): string {
  return QUICK_PICK_RESOURCE_ICON_PREFIX + resource.toString()
}

export function parseResourceIconId(iconId: string): URI | undefined {
  return iconId.startsWith(QUICK_PICK_RESOURCE_ICON_PREFIX)
    ? URI.parse(iconId.slice(QUICK_PICK_RESOURCE_ICON_PREFIX.length))
    : undefined
}
