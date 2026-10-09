/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for release notes: semver comparison and range selection. Kept free
 *  of platform/React deps so they unit-test plainly. Link classification lives in the
 *  shared policy (shared/releaseNotes/linkPolicy.ts) — the compiler uses the same one.
 *--------------------------------------------------------------------------------------------*/

import type { IReleaseNote } from '../../../shared/ipc/releaseNotesService.js'

/**
 * Compare two dotted numeric versions (e.g. `0.1.2`). Returns a negative number
 * when `a < b`, positive when `a > b`, and 0 when equal. Pre-release suffixes
 * (`-beta.1`) are stripped before comparison.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function parseVersion(v: string): number[] {
  const core = v.replace(/^v/, '').split(/[-+]/)[0] ?? ''
  return core.split('.').map((n) => Number.parseInt(n, 10) || 0)
}

/** Versions in `(fromExclusive, toInclusive]`, kept in the input order (newest first). */
export function selectNotesInRange(
  notes: readonly IReleaseNote[],
  fromExclusive: string,
  toInclusive: string,
): IReleaseNote[] {
  return notes.filter(
    (n) =>
      compareVersions(n.version, fromExclusive) > 0 && compareVersions(n.version, toInclusive) <= 0,
  )
}

/**
 * Notes this install may show: everything up to the running app version. A shipped
 * file can carry newer versions (a stale install reading a newer JSON), and the
 * install cannot vouch for what it has never run.
 */
export function notesUpToVersion(
  notes: readonly IReleaseNote[],
  currentVersion: string,
): IReleaseNote[] {
  return notes.filter((n) => n.version === '' || compareVersions(n.version, currentVersion) <= 0)
}
