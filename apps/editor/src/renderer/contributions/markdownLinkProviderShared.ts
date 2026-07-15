/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared core for the markdown drop / paste "insert link" providers. Monaco's
 *  documentDropEditProvider and documentPasteEditProvider hand us the same
 *  `VSDataTransfer` shape (no public monaco.languages.* API for either), so the
 *  logic that turns it into markdown — file uri-list → link, binary image →
 *  `assets/` write + embed — lives here once and both contributions adapt to it.
 *--------------------------------------------------------------------------------------------*/

import {
  URI,
  dirname,
  type IFileService,
  type ILogger,
  type HostPlatform,
} from '@universe-editor/platform'
import { markdownLinksFromUriList } from './markdownPasteLinks.js'
import { formatAssetStamp } from './markdownAssetLinks.js'
import { saveDroppedImageAsset } from './markdownAssetDropper.js'

export const URI_LIST_MIME = 'text/uri-list'
export const TEXT_MIME = 'text/plain'
export const LINK_TITLE = 'Insert Markdown Link'

/** A file entry inside monaco's internal `VSDataTransfer` (see base/common/dataTransfer). */
export interface IVSDataTransferFile {
  readonly name: string
  data(): Promise<Uint8Array>
}
export interface IVSDataTransferItem {
  asString(): Promise<string>
  asFile?(): IVSDataTransferFile | undefined
}
export interface IVSDataTransfer {
  get(mime: string): IVSDataTransferItem | undefined
  /** Real monaco VSDataTransfer is iterable; a minimal stub may omit this. */
  [Symbol.iterator]?(): Iterator<[string, IVSDataTransferItem]>
}

/** The first `image/*` entry that carries file bytes, with its mime type. */
export function findImageFileEntry(
  dataTransfer: IVSDataTransfer,
): { file: IVSDataTransferFile; mime: string } | undefined {
  // Real monaco VSDataTransfer is iterable; guard anyway so a non-iterable stub
  // (or a caller that only implements `get`) degrades to "no image" gracefully.
  const iterate = dataTransfer[Symbol.iterator]
  if (typeof iterate !== 'function') return undefined
  const it = iterate.call(dataTransfer)
  for (let r = it.next(); !r.done; r = it.next()) {
    const [mime, item] = r.value
    if (!mime.startsWith('image/')) continue
    const file = item.asFile?.()
    if (file) return { file, mime }
  }
  return undefined
}

/** Convert a monaco model URI (string form) to a platform URI. */
export function toPlatformUri(monacoUriString: string): URI | undefined {
  try {
    return URI.parse(monacoUriString)
  } catch {
    return undefined
  }
}

export interface MarkdownLinkContext {
  /** Fallback root when `modelUriString` fails to parse as a URI (should not happen in practice). */
  readonly workspaceFolderFsPath: string | undefined
  readonly platform: HostPlatform
  readonly fileService: Pick<IFileService, 'createDirectory' | 'writeFile' | 'exists'>
  readonly logger?: ILogger
  /** Injected so callers stay deterministic/testable; defaults to `new Date()`. */
  readonly now?: () => Date
}

/**
 * Produce the markdown insert **snippet** for a dropped/pasted `VSDataTransfer`,
 * or undefined when nothing applies (caller then yields to the default handler):
 *   1. a `text/uri-list` (files dragged from Explorer/OS) → `![${n:alt text}](rel)`
 *      / `[${n:text}](rel)` snippet(s)
 *   2. otherwise, a binary `image/*` (screenshot, web image, no disk path) →
 *      written to `assets/` beside the markdown file → `![${1:alt text}](assets/…)`
 *
 * The returned string is a snippet (link text is a selected `${n:…}` placeholder,
 * VSCode-style); callers wrap it as `{ snippet }` on the provider edit.
 */
export async function computeMarkdownLinkInsert(
  dataTransfer: IVSDataTransfer,
  modelUriString: string,
  ctx: MarkdownLinkContext,
  isCancelled: () => boolean,
): Promise<string | undefined> {
  const mdUri = toPlatformUri(modelUriString)

  const uriEntry = dataTransfer.get(URI_LIST_MIME)
  if (uriEntry) {
    const raw = await uriEntry.asString()
    if (isCancelled()) return undefined
    if (raw.trim()) {
      // Relative to the *document's own directory* so the link still resolves
      // when the document doesn't live at the workspace root.
      const targetDirFsPath = mdUri ? dirname(mdUri.fsPath) : ctx.workspaceFolderFsPath
      const links = markdownLinksFromUriList(raw, targetDirFsPath, ctx.platform)
      if (links) return links
    }
  }

  const image = findImageFileEntry(dataTransfer)
  if (image) {
    if (!mdUri) return undefined
    const bytes = await image.file.data()
    if (isCancelled()) return undefined
    const stamp = formatAssetStamp((ctx.now ?? (() => new Date()))())
    return saveDroppedImageAsset(ctx.fileService, mdUri, bytes, image.mime, stamp, ctx.logger)
  }

  return undefined
}
