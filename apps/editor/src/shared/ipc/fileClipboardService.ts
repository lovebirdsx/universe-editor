/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for the shared file clipboard. The main process owns the
 *  clipboard state — all windows share one main process, so main memory is the
 *  natural cross-window clipboard, and it keeps full-fidelity `remote-ssh://` URIs
 *  that the OS clipboard cannot carry.
 *
 *  Two sources of truth:
 *  - 'internal': we wrote it ourselves and still own the OS clipboard; the
 *    snapshot carries the original high-fidelity URIs (and the cut flag).
 *  - 'os': another application wrote the OS clipboard (or our ownership could
 *    not be verified); the snapshot carries local fs paths read from the OS,
 *    and callers must always treat the entry as a copy.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event, UriComponents } from '@universe-editor/platform'

export interface IFileClipboardResource {
  readonly resource: UriComponents
  readonly isDirectory: boolean
}

export interface IFileClipboardSnapshot {
  readonly resources: readonly IFileClipboardResource[]
  readonly isCut: boolean
  readonly source: 'internal' | 'os'
}

export interface IFileClipboardWriteCost {
  /** Number of top-level resources that need materialization before they can reach the OS clipboard. */
  readonly materializeCount: number
  /** Total bytes of the materialize-needed resources (recursively). */
  readonly totalBytes: number
  /** Needs materialization and exceeds the confirmation threshold (50MB). */
  readonly needsConfirmation: boolean
  /** Exceeds the hard limits (2GB or 100k entries); the write must be refused. */
  readonly refused: boolean
}

export interface IFileClipboardService {
  readonly _serviceBrand: undefined

  /** Fires whenever the clipboard state changes (write, ownership loss, clear). */
  readonly onDidChangeClipboard: Event<IFileClipboardSnapshot>

  /**
   * Writes resources to the shared clipboard. Resources whose local reveal path
   * cannot be computed (e.g. non-WSL remotes) are materialized into the local
   * temp directory when `opts.materialize` is not false, so the OS clipboard
   * still receives real paths. The in-memory snapshot always keeps the original
   * URIs regardless of materialization.
   */
  writeResources(
    resources: readonly IFileClipboardResource[],
    isCut: boolean,
    opts?: { materialize?: boolean },
  ): Promise<void>

  readResources(): Promise<IFileClipboardSnapshot>

  /**
   * Pre-flight estimate for a write: walks only the resources that need
   * materialization and aborts early once a hard limit is hit.
   */
  checkWriteCost(resources: readonly IFileClipboardResource[]): Promise<IFileClipboardWriteCost>

  /** Clears the shared clipboard. The OS clipboard is only cleared while we still own it. */
  clear(): Promise<void>
}

export const IFileClipboardService = createDecorator<IFileClipboardService>('fileClipboardService')

/** Materialization above this size asks the caller for confirmation before writing. */
export const FILE_CLIPBOARD_CONFIRM_BYTES = 50 * 1024 * 1024
/** Materialization above this size is refused outright. */
export const FILE_CLIPBOARD_REFUSE_BYTES = 2 * 1024 * 1024 * 1024
/** Materialization above this entry count is refused outright. */
export const FILE_CLIPBOARD_REFUSE_ENTRIES = 100_000
