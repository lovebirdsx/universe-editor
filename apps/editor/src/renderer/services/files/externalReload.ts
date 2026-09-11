/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bounded whole-file read for reconciling an open buffer with disk.
 *
 *  Why the bound is shared rather than per-site: every caller answers the same
 *  question — "this file changed on disk, give me its content" — and every caller
 *  is re-entered once per watcher batch for as long as the file keeps changing, so
 *  a file written every second costs a whole-file read, its wire frame and its
 *  decode every second. The renderer death this guards against had exactly that
 *  shape: `large outbound ipc frame 47.6MB (response fileSystem.readFileText)`
 *  repeating until the V8 heap was gone. Four call sites with four thresholds
 *  would drift apart and re-open the hole one site at a time.
 *--------------------------------------------------------------------------------------------*/

import type { IFileService, URI } from '@universe-editor/platform'

/**
 * Ceiling for a reload read. What one reload costs is not the file: it is the file
 * again on the wire, again after decode, plus the character-by-character minimal-edit
 * scan — roughly 4× the text, and about 3× that again when the text hits the V8
 * two-byte representation. At 16MiB a multi-byte file already peaks near a quarter of
 * a gigabyte per reload, and it does so once per change batch, so the line is drawn
 * where a repeat cannot compound into a dead renderer. It matches
 * `sessionChangeTracker`'s MAX_CURRENT_BYTES, which refuses the same order of
 * magnitude for the same reason.
 */
export const MAX_EXTERNAL_RELOAD_BYTES = 16 * 1024 * 1024

export function isTooLargeForExternalReload(size: number): boolean {
  return size > MAX_EXTERNAL_RELOAD_BYTES
}

export type ExternalReloadRead =
  | { readonly ok: true; readonly text: string }
  /** `too-large`: refused by the ceiling. `unreadable`: gone or unreadable. */
  | { readonly ok: false; readonly reason: 'too-large' | 'unreadable' }

/**
 * Read `resource` for an external-change reload, or refuse it as too large.
 *
 * `stat` failing is reported as `unreadable`, the same outcome as a failed read: to
 * both a path that vanished and a path that cannot be read, the caller's answer is
 * "leave the buffer alone".
 */
export async function readForExternalReload(
  files: Pick<IFileService, 'stat' | 'readFileText'>,
  resource: URI,
): Promise<ExternalReloadRead> {
  try {
    const stat = await files.stat(resource)
    if (isTooLargeForExternalReload(stat.size)) return { ok: false, reason: 'too-large' }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  try {
    return { ok: true, text: await files.readFileText(resource) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}
