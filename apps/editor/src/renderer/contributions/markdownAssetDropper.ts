/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Persists a dropped / pasted binary image next to the markdown file (in an
 *  `assets/` sibling folder) and returns the workspace-shaped markdown link. This
 *  is the renderer editing enhancement (drag-and-drop / paste into editor), NOT
 *  the markdown extension's gated `workspace.fs` — it writes through the renderer
 *  IFileService like the Explorer's own new-file / new-folder flow.
 *
 *  Kept as a plain function over a minimal IFileService slice (no DI class) so
 *  both the drop and paste providers can call it and it stays unit-testable with
 *  a stub file service.
 *--------------------------------------------------------------------------------------------*/

import { URI, type IFileService, type ILogger } from '@universe-editor/platform'
import { assetFileName, imageExtensionForMime, markdownLinkForPath } from './markdownAssetLinks.js'

const ASSETS_DIR = 'assets'
/** Guard against pathological same-second collisions; well beyond any real drop. */
const MAX_NAME_ATTEMPTS = 1000

export type AssetFileService = Pick<IFileService, 'createDirectory' | 'writeFile' | 'exists'>

/** Directory URI of a file resource (its parent). */
function dirOf(resource: URI): URI {
  const path = resource.path
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return resource
  return resource.with({ path: path.slice(0, slash) })
}

/**
 * Write `bytes` as an image asset beside `mdFileUri` and return the markdown
 * embed for it (`![](assets/image-<stamp>.png)`), or undefined when the mime is
 * not a recognised image or the write fails. `stamp` is injected (formatted from
 * a Date by the caller) so this stays deterministic and testable.
 */
export async function saveDroppedImageAsset(
  fileService: AssetFileService,
  mdFileUri: URI,
  bytes: Uint8Array,
  mime: string,
  stamp: string,
  logger?: ILogger,
): Promise<string | undefined> {
  const ext = imageExtensionForMime(mime)
  if (!ext) {
    logger?.debug(`[markdownAsset] unsupported image mime: ${mime}`)
    return undefined
  }

  const assetsDir = URI.joinPath(dirOf(mdFileUri), ASSETS_DIR)
  try {
    // recursive mkdir — idempotent when assets/ already exists.
    await fileService.createDirectory(assetsDir)

    let name = assetFileName(ext, stamp, 0)
    let target = URI.joinPath(assetsDir, name)
    for (let i = 1; i < MAX_NAME_ATTEMPTS && (await fileService.exists(target)); i++) {
      name = assetFileName(ext, stamp, i)
      target = URI.joinPath(assetsDir, name)
    }

    await fileService.writeFile(target, bytes)
    const rel = `${ASSETS_DIR}/${name}`
    logger?.info(`[markdownAsset] wrote ${target.toString()} bytes=${bytes.byteLength}`)
    return markdownLinkForPath(rel, true)
  } catch (err) {
    logger?.warn(`[markdownAsset] failed to write asset for ${mdFileUri.toString()}`, err)
    return undefined
  }
}
