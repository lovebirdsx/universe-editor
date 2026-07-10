/**
 * Parsers for structured `p4` output. Two formats, both pure and side-effect
 * free so they can be unit-tested against fixtures:
 *
 *  - `-Mj` (marshalled JSON): one JSON object per line. Preferred — cheapest to
 *    consume. Lines that aren't valid JSON (rare banner text) are skipped.
 *  - `-ztag` (tagged text): records of `... key value` lines separated by blank
 *    lines. Some commands (e.g. `describe -S`) emit *parallel numbered* keys —
 *    `depotFile0`, `depotFile1`, … — for a repeated field; `collapseNumberedKeys`
 *    folds those back into a single array under the base key.
 *
 * `-G` (Python marshal) is intentionally unsupported: it's awkward from Node.
 */

/** One parsed record: scalar strings, or arrays for collapsed numbered keys. */
export type P4Record = Record<string, string | string[]>

/** Parse `p4 -Mj` output: one JSON object per non-empty line. */
export function parseMarshalJson(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as unknown
      if (obj && typeof obj === 'object') out.push(obj as Record<string, unknown>)
    } catch {
      // Not JSON (banner / warning line) — skip.
    }
  }
  return out
}

/**
 * Parse `p4 -ztag` output into records. Each `... key value` line adds a field;
 * a blank line closes the current record. Numbered parallel keys are collapsed
 * into arrays (see {@link collapseNumberedKeys}).
 */
export function parseZtag(stdout: string): P4Record[] {
  const records: P4Record[] = []
  let current: Map<string, string> | undefined

  const flush = (): void => {
    if (current && current.size > 0) records.push(collapseNumberedKeys(current))
    current = undefined
  }

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('... ')) {
      const rest = line.slice(4)
      const sp = rest.indexOf(' ')
      const key = sp === -1 ? rest : rest.slice(0, sp)
      const value = sp === -1 ? '' : rest.slice(sp + 1)
      if (!current) current = new Map()
      current.set(key, value)
    } else if (line.trim() === '') {
      flush()
    }
    // Non-tagged text lines (e.g. `text:` continuations) are ignored for v1.
  }
  flush()
  return records
}

/**
 * Convert `p4 -ztag` output into records shaped like `-Mj` JSON records: flat
 * scalar keys (numbered parallel keys `depotFile0/1/…` are kept flat, NOT
 * collapsed into arrays), so the `-Mj` parsers consume them unchanged.
 *
 * This is the fallback path for servers/commands where `-Mj` collapses every
 * line into a single `{"data": "..."}` blob and drops the structured fields
 * (observed on this project's P4D for `changes` / `describe` / `where` — the
 * report-style commands; script-style commands like `fstat` stay structured).
 * `-ztag` still carries the real fields there.
 *
 * Record boundaries are NOT taken from blank lines: a `describe` record has a
 * blank line *inside* it (between a multi-line `desc` and the file list). Instead
 * a new record starts when a key that's already present in the current record
 * reappears (`change` for `changes`, `depotFile` for `where`). Non-tagged lines
 * (no `... ` prefix) and blank lines append to the last field's value, so a
 * multi-line `desc` is preserved in full.
 */
export function parseZtagAsMarshal(stdout: string): Record<string, string>[] {
  const records: Record<string, string>[] = []
  let current: Record<string, string> | undefined
  let lastKey: string | undefined
  let pendingBlank = false

  const flush = (): void => {
    if (current && Object.keys(current).length > 0) records.push(current)
    current = undefined
    lastKey = undefined
    pendingBlank = false
  }

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('... ')) {
      const rest = line.slice(4)
      const sp = rest.indexOf(' ')
      const key = sp === -1 ? rest : rest.slice(0, sp)
      const value = sp === -1 ? '' : rest.slice(sp + 1)
      if (current && key in current) flush()
      if (!current) current = {}
      current[key] = value
      lastKey = key
      pendingBlank = false
    } else if (line.trim() === '') {
      // Blank line: a record separator or the gap inside a describe record
      // (between a multi-line desc and the file list). Never part of a value.
      pendingBlank = current !== undefined
    } else if (current && lastKey) {
      // Continuation line of a multi-line value (e.g. a wrapped `desc`). A blank
      // line seen just before it was a real in-value blank, so restore it.
      current[lastKey] += pendingBlank ? `\n\n${line}` : `\n${line}`
      pendingBlank = false
    }
  }
  flush()
  return records
}

/**
 * Fold parallel numbered keys (`depotFile0`, `depotFile1`, …) into a single
 * array field keyed by the base name (`depotFile`), preserving numeric order.
 * Plain keys pass through unchanged. Keys that end in digits but have no sibling
 * with a different index are still treated as an array of one, matching how p4
 * emits repeated fields.
 */
export function collapseNumberedKeys(fields: Map<string, string>): P4Record {
  const scalars: Record<string, string> = {}
  const arrays = new Map<string, Map<number, string>>()

  for (const [key, value] of fields) {
    const m = /^(.*?)(\d+)$/.exec(key)
    if (m && m[1]) {
      const base = m[1]
      const index = Number(m[2])
      let bucket = arrays.get(base)
      if (!bucket) {
        bucket = new Map()
        arrays.set(base, bucket)
      }
      bucket.set(index, value)
    } else {
      scalars[key] = value
    }
  }

  const out: P4Record = { ...scalars }
  for (const [base, bucket] of arrays) {
    const ordered = [...bucket.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    out[base] = ordered
  }
  return out
}
