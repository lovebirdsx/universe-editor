/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Image file-type detection — keyed off the file extension, matching VSCode's
 *  media-preview built-in. Kept as pure functions for unit testing and reuse by
 *  the editor binding registration.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'
import { basenameOfResource, extensionOfBasename } from '../../workbench/files/resourceInfo.js'

/** Extensions the image editor claims. Lowercase, leading dot. */
export const IMAGE_FILE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
  '.apng',
  '.svg',
]

const IMAGE_EXT_SET = new Set(IMAGE_FILE_EXTENSIONS)

/** True when the resource's extension names an image the editor can render. */
export function isImageResource(resource: URI): boolean {
  const ext = extensionOfBasename(basenameOfResource(resource))
  return ext !== null && IMAGE_EXT_SET.has(ext)
}
