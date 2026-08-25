/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Linux OS clipboard backend. Writes the `x-special/gnome-copied-files` format,
 *  which Nautilus / Nemo / Caja / Thunar all read for "paste files into the file
 *  manager" — it is the only custom format that reaches them, and it can carry
 *  the cut action.
 *
 *  Verified against Electron 43 (empirically, with a live clipboard probe):
 *  every clipboard.write* call commits a FRESH clipboard state and replaces all
 *  formats — `writeBuffer` wipes text/plain and vice versa, and the multi-format
 *  `clipboard.write()` API is non-functional on Linux. So only the gnome format
 *  is written; a stacked writeText would destroy it. The cost of this asymmetry
 *  (vs Windows, where one DataObject carries both CF_HDROP and text): pasting
 *  into a terminal does NOT receive the path text on Linux.
 * `availableFormats()` is NOT used to pre-check the custom format: on Linux it
 * only enumerates standard formats (returns [] right after our own writeBuffer),
 * while `readBuffer`/`has` do see custom formats — so readBuffer is the probe.
 *--------------------------------------------------------------------------------------------*/

import { clipboard } from 'electron'
import { URI } from '@universe-editor/platform'
import type { IOsClipboardBackend, IOsClipboardReadResult } from './osClipboardBackend.js'

const GNOME_COPIED_FILES_FORMAT = 'x-special/gnome-copied-files'
const URI_LIST_FORMAT = 'text/uri-list'

export type GnomeCopiedFilesAction = 'copy' | 'cut'

export interface ParsedGnomeCopiedFiles {
  readonly action: GnomeCopiedFilesAction
  readonly uris: readonly string[]
}

/** `copy\n<uri>\n<uri>…` payload for the x-special/gnome-copied-files format. */
export function encodeGnomeCopiedFiles(
  action: GnomeCopiedFilesAction,
  fileUris: readonly string[],
): string {
  return `${action}\n${fileUris.join('\n')}`
}

/**
 * Parses a gnome-copied-files payload. Splits on any CR / LF combination (see
 * the uriList.ts lesson: `/\r?\n/` would collapse CR-separated entries).
 * Undefined for a missing/unknown action or an empty URI list.
 */
export function parseGnomeCopiedFiles(text: string): ParsedGnomeCopiedFiles | undefined {
  if (!text) return undefined
  const lines = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const action = lines[0]
  if (action !== 'copy' && action !== 'cut') return undefined
  const uris = lines.slice(1)
  if (uris.length === 0) return undefined
  return { action, uris }
}

/** Parses a text/uri-list payload (RFC 2483: blank lines and `#` comments skipped). */
export function parseUriListText(text: string): string[] {
  if (!text) return []
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function pathsToFileUris(paths: readonly string[]): string[] {
  return paths.map((p) => URI.file(p).toString())
}

function fileUriToFsPath(uriText: string): string | undefined {
  try {
    const uri = URI.parse(uriText)
    return uri.scheme === 'file' ? uri.fsPath : undefined
  } catch {
    return undefined
  }
}

export class OsClipboardLinuxBackend implements IOsClipboardBackend {
  async writeFiles(
    paths: readonly string[],
    isCut: boolean,
  ): Promise<{ ok: boolean; signature: string }> {
    const payload = encodeGnomeCopiedFiles(isCut ? 'cut' : 'copy', pathsToFileUris(paths))
    clipboard.writeBuffer(GNOME_COPIED_FILES_FORMAT, Buffer.from(payload))
    return { ok: true, signature: payload }
  }

  async readFiles(): Promise<IOsClipboardReadResult | undefined> {
    const gnome = clipboard.readBuffer(GNOME_COPIED_FILES_FORMAT)
    if (gnome.length > 0) {
      const text = gnome.toString('utf8')
      const parsed = parseGnomeCopiedFiles(text)
      if (parsed) {
        const paths = parsed.uris.map(fileUriToFsPath).filter((p): p is string => p !== undefined)
        if (paths.length > 0) {
          return { paths, isCut: parsed.action === 'cut', signature: text }
        }
      }
    }
    const uriList = clipboard.readBuffer(URI_LIST_FORMAT)
    if (uriList.length > 0) {
      const text = uriList.toString('utf8')
      const paths = parseUriListText(text)
        .map(fileUriToFsPath)
        .filter((p): p is string => p !== undefined)
      if (paths.length > 0) {
        return { paths, isCut: false, signature: text }
      }
    }
    return undefined
  }

  async clear(): Promise<void> {
    clipboard.clear()
  }
}
