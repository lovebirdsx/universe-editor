/**
 * A deliberately tiny semver `satisfies` for validating an extension's
 * `engines.universe` against the host API version. It covers only the range
 * syntax we actually emit/accept — exact, `*`/`x`, partial (`1`, `1.2`), caret
 * (`^`), tilde (`~`), the comparison operators, and space-joined ANDs (e.g.
 * `>=0.1.0 <1.0.0`). Anything it can't parse (compound `||`, hyphen ranges) is
 * rejected **fail-closed**: an extension declaring an unrecognised range won't
 * load rather than load against an incompatible host.
 *
 * Prerelease/build metadata is ignored. The host is pre-1.0, so caret on a 0.x
 * base follows npm semantics (locks the minor).
 */

type Version = readonly [major: number, minor: number, patch: number]

function parseVersion(value: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Fill missing components with 0: `1` → `1.0.0`, `1.2` → `1.2.0`. */
function coerce(value: string): string {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim())
  if (!m) return value
  return `${m[1]}.${m[2] ?? '0'}.${m[3] ?? '0'}`
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

function caretUpper([major, minor, patch]: Version): Version {
  if (major > 0) return [major + 1, 0, 0]
  if (minor > 0) return [0, minor + 1, 0]
  return [0, 0, patch + 1]
}

function tildeUpper([major, minor]: Version): Version {
  return [major, minor + 1, 0]
}

/** Match a partial/wildcard spec like `1`, `1.2`, `1.x`, `1.2.*`. */
function matchPartial(version: Version, spec: string): boolean {
  const parts = spec.trim().split('.')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === undefined || p === '' || p === 'x' || p === 'X' || p === '*') return true
    const num = Number(p)
    if (!Number.isInteger(num)) return false
    if ((version[i] ?? 0) !== num) return false
  }
  return true
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  if (!v) return false

  const r = range.trim()
  if (r === '' || r === '*' || r === 'x' || r === 'X') return true
  // `||` (OR) is unsupported → fail closed.
  if (r.includes('||')) return false

  // Space-joined comparators are ANDed together (e.g. `>=0.1.0 <1.0.0`). A single
  // comparator is just the one-element case.
  const parts = r.split(/\s+/)
  return parts.every((part) => satisfiesOne(v, part))
}

/** Evaluate a single comparator (no whitespace) against an already-parsed version. */
function satisfiesOne(v: Version, comparator: string): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(comparator)
  if (!m) return false
  const op = m[1] ?? ''
  const rest = m[2]!

  if (op === '' || op === '=') return matchPartial(v, rest)

  const target = parseVersion(coerce(rest))
  if (!target) return false
  const cmp = compare(v, target)
  switch (op) {
    case '>':
      return cmp > 0
    case '>=':
      return cmp >= 0
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
    case '^':
      return cmp >= 0 && compare(v, caretUpper(target)) < 0
    case '~':
      return cmp >= 0 && compare(v, tildeUpper(target)) < 0
    default:
      return false
  }
}

/**
 * Compare two semver strings: -1 / 0 / 1. Unparseable versions sort as 0.0.0.
 * Prerelease/build metadata ignored (mirrors {@link satisfies}).
 */
export function compareVersions(a: string, b: string): number {
  return compare(parseVersion(a) ?? [0, 0, 0], parseVersion(b) ?? [0, 0, 0])
}
