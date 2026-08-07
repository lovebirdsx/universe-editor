/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Editor self-write registry — FileEditorInput.save() notes each disk write
 *  here so consumers watching the filesystem (e.g. the session watched-changes
 *  fallback) can tell "the user saved in this editor" apart from an external
 *  write. Module-level on purpose: the producer runs deep inside the save path
 *  and the entries are transient (seconds). Raw URIs are stored — consumers
 *  compare with their own IUriIdentityService, never with hand-rolled path keys.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'

const MAX_ENTRIES = 128

interface SelfWrite {
  readonly uri: URI
  readonly at: number
}

const writes: SelfWrite[] = []

export function noteSelfWrite(uri: URI): void {
  writes.push({ uri, at: Date.now() })
  if (writes.length > MAX_ENTRIES) writes.splice(0, writes.length - MAX_ENTRIES)
}

/** URIs written by the editor itself within the last `windowMs`. Prunes expired
 *  entries as a side effect. */
export function recentSelfWrites(windowMs: number): readonly URI[] {
  const cutoff = Date.now() - windowMs
  let firstLive = 0
  while (firstLive < writes.length && writes[firstLive]!.at < cutoff) firstLive++
  if (firstLive > 0) writes.splice(0, firstLive)
  return writes.map((w) => w.uri)
}

export function resetSelfWritesForTests(): void {
  writes.length = 0
}
