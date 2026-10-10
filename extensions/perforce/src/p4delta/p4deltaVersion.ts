/**
 * p4delta version parsing and ordering — the numbers behind "is the upstream
 * release newer than the copy on disk?".
 *
 * Deliberately strict: a version is exactly `[v]MAJOR.MINOR.PATCH`, with no
 * pre-release or build suffix. The only inputs are the two places upstream
 * spells a version (a release tag like `v0.1.10`, a mirror's `latest.json`), and
 * GitHub's `GET /releases/latest` never returns a pre-release — so anything else
 * means we are not looking at what we think we are, and the caller must refuse
 * to act on it rather than guess an ordering from it.
 *
 * Nothing here probes a binary or judges whether a build is usable: the δ
 * engine is admitted on existence alone (see `resolveP4deltaEngine`), and a
 * wrong build is left to the client's failure ladder. These versions only
 * compare what upstream offers against what is already on disk.
 */
export type P4deltaVersion = readonly [number, number, number]

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

/** `'v0.1.10'` / `'0.1.10'` → `[0, 1, 10]`; anything else → undefined. */
export function parseP4deltaVersion(text: string): P4deltaVersion | undefined {
  const match = VERSION_RE.exec(text.trim())
  if (match === null) return undefined
  return [Number(match[1]!), Number(match[2]!), Number(match[3]!)]
}

/** The spelling every on-disk name uses: `<version>/` directories and `.active`. */
export function formatP4deltaVersion(version: P4deltaVersion): string {
  return `${version[0]}.${version[1]}.${version[2]}`
}

/** Standard semantic ordering; `0` means equal. */
export function compareP4deltaVersion(a: P4deltaVersion, b: P4deltaVersion): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1
  return 0
}
