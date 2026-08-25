/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Platform backend contract for writing/reading file lists on the OS clipboard.
 *  The Electron `clipboard` module and any PowerShell spawning live behind this
 *  interface so FileClipboardMainService is unit-testable with a fake.
 *
 *  The signature is the normalized clipboard content string itself (Windows:
 *  newline-joined paths; Linux: the gnome-copied-files payload; mac: the plist
 *  text). It is NOT a separate invented format — the service compares the
 *  signature it got from writeFiles against the signature recomputed by
 *  readFiles to decide whether we still own the OS clipboard.
 *--------------------------------------------------------------------------------------------*/

export interface IOsClipboardReadResult {
  readonly paths: readonly string[]
  readonly isCut: boolean
  /** Signature recomputed from the raw clipboard content just read. */
  readonly signature: string
}

export interface IOsClipboardBackend {
  /**
   * Writes the file list to the OS clipboard. `ok: false` means the primary
   * mechanism degraded (e.g. PowerShell unavailable, clipboard locked) — the
   * clipboard may still carry a text fallback, and the returned signature
   * describes what was written. The in-memory clipboard state stays usable
   * either way.
   */
  writeFiles(paths: readonly string[], isCut: boolean): Promise<{ ok: boolean; signature: string }>
  /** Reads the OS clipboard file list. Undefined when it carries no file content. */
  readFiles(): Promise<IOsClipboardReadResult | undefined>
  clear(): Promise<void>
}
