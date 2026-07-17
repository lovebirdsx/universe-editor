/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  searchCompare — deterministic ordering of search results.
 *
 *  ripgrep streams file matches in a nondeterministic, thread-completion order,
 *  so the same query can surface files in a different order run to run. The fix
 *  (mirroring VSCode's search tree) is to never trust the arrival order: the
 *  view derives its order purely from the resource paths here. Ported from
 *  VSCode's `comparePaths` / `compareFileNames` (base/common/comparers.ts):
 *  compare path segments folder-by-folder (case-insensitive), then the basename
 *  with a numeric-aware collator so `f2` sorts before `f10`.
 *--------------------------------------------------------------------------------------------*/

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const collatorIsNumeric = collator.resolvedOptions().numeric

/** Numeric-aware, case-insensitive basename compare; unicode-disambiguates ties. */
function compareFileNames(one: string, other: string): number {
  const a = one || ''
  const b = other || ''
  const result = collator.compare(a, b)
  // The numeric option makes compare(`foo1`, `foo01`) === 0 — disambiguate.
  if (collatorIsNumeric && result === 0 && a !== b) {
    return a < b ? -1 : 1
  }
  return result
}

function comparePathComponents(one: string, other: string): number {
  const a = one.toLowerCase()
  const b = other.toLowerCase()
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Compare two forward-slashed paths segment by segment, basename last. */
export function comparePaths(one: string, other: string): number {
  const oneParts = one.split('/')
  const otherParts = other.split('/')
  const lastOne = oneParts.length - 1
  const lastOther = otherParts.length - 1

  for (let i = 0; ; i++) {
    const endOne = lastOne === i
    const endOther = lastOther === i

    if (endOne && endOther) return compareFileNames(oneParts[i]!, otherParts[i]!)
    if (endOne) return -1
    if (endOther) return 1

    const result = comparePathComponents(oneParts[i]!, otherParts[i]!)
    if (result !== 0) return result
  }
}
