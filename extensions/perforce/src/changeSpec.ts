/**
 * Pure helpers for the Perforce *change spec* form — the text `p4 change -o`
 * emits and `p4 change -i` consumes. No p4 I/O here so the form manipulation is
 * unit-testable against fixtures.
 *
 * A change spec looks like:
 *
 *   Change: new
 *   Client: my-client
 *   User: alice
 *   Status: new
 *   Description:
 *   \t<line 1>
 *   \t<line 2>
 *   Files:
 *   \t//depot/main/foo.txt # edit
 *
 * Field bodies are tab-indented continuation lines; a field ends at the next
 * unindented `Key:` line (or EOF). We only ever touch the Description block —
 * everything else round-trips verbatim so we never disturb the Files list or
 * server-managed fields.
 */

/** Indent a multi-line description body with p4's leading tab per line. */
function indentBody(description: string): string {
  const lines = description.replace(/\r\n/g, '\n').split('\n')
  // Drop a single trailing empty line so we don't emit a dangling blank tab.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines.map((l) => `\t${l}`).join('\n')
}

/**
 * Build a minimal change spec for `p4 change -i` that creates a new pending
 * changelist with `description`. `Change: new` tells the server to allocate a
 * number; Client/User are filled from the connection so the spec is complete
 * even on servers that don't inject them.
 */
export function buildNewChangeSpec(
  description: string,
  conn?: { client?: string; user?: string },
): string {
  const lines = ['Change: new']
  if (conn?.client) lines.push(`Client: ${conn.client}`)
  if (conn?.user) lines.push(`User: ${conn.user}`)
  lines.push('Status: new', 'Description:', indentBody(description || '<enter description>'))
  return `${lines.join('\n')}\n`
}

/**
 * Replace the Description block of an existing `p4 change -o` spec with
 * `description`, leaving every other field (Files, Jobs, etc.) untouched.
 * Returns the rewritten spec ready for `p4 change -i`.
 */
export function replaceDescription(spec: string, description: string): string {
  const src = spec.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let replaced = false

  while (i < src.length) {
    const line = src[i]!
    if (/^Description:\s*$/.test(line)) {
      out.push('Description:')
      out.push(indentBody(description))
      i++
      // Skip the old (tab-indented or blank) body up to the next unindented key.
      while (i < src.length && (src[i] === '' || /^[ \t]/.test(src[i]!))) i++
      replaced = true
      continue
    }
    out.push(line)
    i++
  }

  if (!replaced) {
    // No Description field present (unusual) — append one.
    out.push('Description:', indentBody(description))
  }
  return `${out.join('\n').replace(/\n*$/, '')}\n`
}

/** Extract the current description body from a `p4 change -o` spec (de-indented,
 *  trimmed of the leading tab per line). Empty when absent. */
export function parseDescription(spec: string): string {
  const src = spec.replace(/\r\n/g, '\n').split('\n')
  let i = src.findIndex((l) => /^Description:\s*$/.test(l))
  if (i === -1) return ''
  i++
  const body: string[] = []
  while (i < src.length && (src[i] === '' || /^[ \t]/.test(src[i]!))) {
    body.push(src[i]!.replace(/^\t/, ''))
    i++
  }
  return body.join('\n').trim()
}
