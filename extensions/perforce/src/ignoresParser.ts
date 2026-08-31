/**
 * Parse `p4 ignores -i <path…>` output back into the exact requested input
 * strings.
 *
 * p4 echoes its OWN normalized absolute local path, which may differ from what
 * we sent in case and separators. The host keys the ignored result against the
 * exact input strings (path → dimmed row), so returning p4's echo verbatim would
 * silently fail to match and leave the row undimmed — the reverse look-up is
 * what guarantees `result[i] === requested[j]` byte-for-byte. Lines that don't
 * map back to any request (p4's informational / noise lines) are dropped.
 */
import { scopeKey } from './pathUtil.js'

export function parseIgnores(stdout: string, requested: readonly string[]): string[] {
  const byKey = new Map<string, string>()
  for (const p of requested) byKey.set(scopeKey(p), p)

  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of stdout.split(/\r?\n/)) {
    // A line that began with whitespace is a continuation of the previous hit
    // (p4 indents the annotation block), not a path of its own.
    if (raw === '' || /^\s/.test(raw)) continue
    const line = raw.trim()
    if (line === '') continue
    // A hit prints as `<path> ignored`. Strip that suffix first, but also try
    // the whole line: a file whose name itself ends in ` ignored` prints as
    // `<path> ignored ignored`, where stripping once would lose the name.
    const candidates = line.endsWith(' ignored')
      ? [line.slice(0, -' ignored'.length), line]
      : [line]
    for (const c of candidates) {
      const hit = byKey.get(scopeKey(c))
      if (hit === undefined) continue
      if (!seen.has(hit)) {
        seen.add(hit)
        out.push(hit)
      }
      break
    }
  }
  return out
}
