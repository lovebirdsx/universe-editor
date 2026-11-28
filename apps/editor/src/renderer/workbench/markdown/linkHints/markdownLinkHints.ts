/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Link-hint label generation — vimium-style. Builds prefix-free, length-balanced
 *  labels from a small home-row character set so a few keystrokes select any link
 *  in the markdown preview (press `f`, type the overlaid label, jump).
 *
 *  The algorithm is a breadth-first expansion of a k-ary prefix tree (k = number
 *  of hint chars): a queue holds candidate labels, and an `offset` cursor marks
 *  how many have been expanded into internal nodes. An expanded label becomes a
 *  prefix of its children, so it is never handed out as a leaf — that guarantees
 *  no label is a prefix of another (unambiguous incremental matching). Labels are
 *  built reversed then sorted+reversed back so short labels spread evenly across
 *  the page rather than clustering on the first character.
 *--------------------------------------------------------------------------------------------*/

/** Home-row keys: fast to type, no finger leaves the base position. */
export const DEFAULT_HINT_CHARS = 'asdfghjkl'

/**
 * Generate `count` prefix-free hint labels from `chars`. Pure; the result is
 * stable for stable inputs. Returns an empty array for `count <= 0`.
 */
export function generateHintLabels(count: number, chars: string = DEFAULT_HINT_CHARS): string[] {
  if (count <= 0) return []
  const charset = chars.length > 1 ? chars : DEFAULT_HINT_CHARS
  const hints: string[] = ['']
  let offset = 0
  // Expand until enough leaves remain in the queue (queue length minus the
  // already-expanded prefixes before `offset`). The `length === 1` guard forces
  // the first expansion even for a single link, so it never gets the empty label.
  while (hints.length - offset < count || hints.length === 1) {
    const prefix = hints[offset++] ?? ''
    for (const ch of charset) hints.push(ch + prefix)
  }
  const leaves = hints.slice(offset, offset + count)
  leaves.sort()
  return leaves.map((s) => reverse(s))
}

function reverse(s: string): string {
  let out = ''
  for (let i = s.length - 1; i >= 0; i--) out += s[i]
  return out
}
