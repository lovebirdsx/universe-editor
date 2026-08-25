/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  macOS OS clipboard backend: `NSFilenamesPboardType`, the NSPasteboard type
 *  Finder reads for file copy/paste, as an XML plist array of path strings.
 *  Best-effort — the repo has no mac packaging, but the code path must exist.
 *
 *  The type carries no cut action (macOS pastes are always copies), so `isCut`
 *  is ignored on write and reported false on read.
 *--------------------------------------------------------------------------------------------*/

import { clipboard } from 'electron'
import type { IOsClipboardBackend, IOsClipboardReadResult } from './osClipboardBackend.js'

const NSFILENAMES_PBOARD_TYPE = 'NSFilenamesPboardType'

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
}

/** Escapes XML text content (element text only; no attribute context here). */
export function escapeXmlText(text: string): string {
  return text.replace(/[&<>]/g, (ch) => XML_ESCAPES[ch] ?? ch)
}

/** Unescapes the entities produced by {@link escapeXmlText}. */
export function unescapeXmlText(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (match, name: string) => {
    switch (name) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      default:
        return '>'
    }
  })
}

/** Builds the NSFilenamesPboardType plist payload for `paths`. */
export function buildNsfilenamesPlist(paths: readonly string[]): string {
  const items = paths.map((p) => `\t<string>${escapeXmlText(p)}</string>`).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
    items,
    '</array>',
    '</plist>',
  ].join('\n')
}

/** Parses an NSFilenamesPboardType plist back into paths. Undefined when it contains no <string>. */
export function parseNsfilenamesPlist(xml: string): string[] | undefined {
  const matches = [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)]
  if (matches.length === 0) return undefined
  return matches.map((match) => unescapeXmlText(match[1] ?? ''))
}

export class OsClipboardMacBackend implements IOsClipboardBackend {
  async writeFiles(
    paths: readonly string[],
    isCut: boolean,
  ): Promise<{ ok: boolean; signature: string }> {
    void isCut
    const payload = buildNsfilenamesPlist(paths)
    clipboard.writeBuffer(NSFILENAMES_PBOARD_TYPE, Buffer.from(payload))
    return { ok: true, signature: payload }
  }

  async readFiles(): Promise<IOsClipboardReadResult | undefined> {
    const buffer = clipboard.readBuffer(NSFILENAMES_PBOARD_TYPE)
    if (buffer.length === 0) return undefined
    const text = buffer.toString('utf8')
    const paths = parseNsfilenamesPlist(text)
    if (!paths || paths.length === 0) return undefined
    return { paths, isCut: false, signature: text }
  }

  async clear(): Promise<void> {
    clipboard.clear()
  }
}
