/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Binary detection on a small head sample. Two callers need "does this file hold
 *  text?": the pre-open large-file guard (which asks the user instead of opening
 *  it in Monaco) and the session-change watcher (which must not adopt a compiled
 *  binary artifact as a tracked change). Both need the same heuristic and the
 *  same fail-open policy when the head can't be read, so both live here rather
 *  than drifting apart at each call site.
 *--------------------------------------------------------------------------------------------*/

import type { IFileService, URI } from '@universe-editor/platform'

/** Binary-detection sample window, matching VSCode's ZERO_BYTE_DETECTION_BUFFER_MAX_LEN. */
export const BINARY_DETECTION_BUFFER_MAX_LEN = 512

/** Heuristic: a buffer containing a NUL byte is treated as binary. */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

/**
 * Reads the head of `resource` and reports whether it looks binary.
 *
 * `undefined` means "could not tell" (the head read failed) — callers decide
 * what that implies. Every current caller lets the file through, so a transient
 * read failure never silently hides content; a caller that needs the opposite
 * default must handle `undefined` explicitly rather than assuming `false`.
 */
export async function probeIsBinary(
  files: Pick<IFileService, 'readFileHead'>,
  resource: URI,
): Promise<boolean | undefined> {
  try {
    return isBinaryBytes(await files.readFileHead(resource, BINARY_DETECTION_BUFFER_MAX_LEN))
  } catch {
    return undefined
  }
}
