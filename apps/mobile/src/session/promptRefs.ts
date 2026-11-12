import {
  MAX_PROMPT_REFS,
  MAX_PROMPT_REF_BYTES_TOTAL,
  promptRefPrefix,
  utf8ByteLength,
  type MobilePromptRef,
  type MobilePromptRefSuggestion,
  type MobilePromptRefTrigger,
} from '@universe-editor/mobile-protocol'

/** An in-progress `@<query>` / `#<query>` token at the caret. */
export interface PromptRefQuery {
  readonly trigger: MobilePromptRefTrigger
  readonly query: string
  /** Offset of the leading `@` / `#`. */
  readonly start: number
  /** One past the last character of the query (exclusive). */
  readonly end: number
}

function extractQuery(
  trigger: MobilePromptRefTrigger,
  text: string,
  caret: number,
): PromptRefQuery | null {
  if (caret < 0 || caret > text.length) return null
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]!
    if (/\s/.test(ch)) return null
    if (ch === '@' || ch === '#') {
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null
      if (ch !== trigger) return null
      let end = i + 1
      while (end < text.length && !/\s/.test(text[end]!)) end++
      if (caret > end) return null
      return { trigger, query: text.slice(i + 1, end), start: i, end }
    }
    i--
  }
  return null
}

/** Mirrors the desktop input: the trigger must start the text or follow whitespace. */
export function extractMentionQuery(text: string, caret: number): PromptRefQuery | null {
  return extractQuery('@', text, caret)
}

export function extractHashQuery(text: string, caret: number): PromptRefQuery | null {
  return extractQuery('#', text, caret)
}

/**
 * A picked suggestion tracked by character range. Tracking offsets (rather than
 * re-scanning labels) is what makes labels with spaces survive later edits.
 */
export interface PlacedPromptRef {
  readonly ref: MobilePromptRefSuggestion
  readonly start: number
  readonly end: number
}

/**
 * Map tracked refs across one text edit. The changed span is the gap between
 * the common prefix and suffix; refs fully before it stay put, refs fully after
 * it shift by the length delta, and refs overlapping it are dropped — their
 * token no longer exists verbatim, so sending it would be rejected anyway.
 */
export function applyTextEdit(
  previous: string,
  next: string,
  placed: readonly PlacedPromptRef[],
): PlacedPromptRef[] {
  if (placed.length === 0) return []
  let prefix = 0
  const maxPrefix = Math.min(previous.length, next.length)
  while (prefix < maxPrefix && previous[prefix] === next[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(previous.length, next.length) - prefix
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }
  const delta = next.length - previous.length
  const suffixStart = previous.length - suffix
  const result: PlacedPromptRef[] = []
  for (const candidate of placed) {
    if (candidate.end <= prefix) {
      result.push(candidate)
      continue
    }
    if (candidate.start >= suffixStart) {
      result.push({
        ref: candidate.ref,
        start: candidate.start + delta,
        end: candidate.end + delta,
      })
      continue
    }
    // The edit cut through the token; drop it.
  }
  return result
}

/**
 * Replace the active token with the picked suggestion's display text. A
 * character immediately following a no-whitespace label gets a separating
 * space so the next token (or word) is still recognized; the caret lands after
 * that space.
 */
export function insertPromptRef(
  text: string,
  start: number,
  end: number,
  suggestion: MobilePromptRefSuggestion,
): { readonly text: string; readonly caret: number; readonly placed: PlacedPromptRef } {
  const token = `${promptRefPrefix(suggestion.kind)}${suggestion.label}`
  const before = text.slice(0, start)
  const after = text.slice(end)
  const next = before + token
  const following = after[0]
  const needsSpace = following !== undefined && !/\s/.test(following)
  return {
    text: next + (needsSpace ? ' ' : '') + after,
    caret: next.length + (needsSpace ? 1 : 0),
    placed: { ref: suggestion, start, end: start + token.length },
  }
}

/**
 * Final check before sending: keep only refs whose range still holds the exact
 * `prefix + label` text, sort by offset, drop overlaps and cap the result at
 * the protocol limit (the extra tokens stay as plain text). Overlapping refs
 * would fail the whole prompt, so they are dropped here rather than at send.
 */
export function collectPlacedRefs(
  text: string,
  placed: readonly PlacedPromptRef[],
): MobilePromptRef[] {
  const valid = placed.filter((candidate) => {
    if (
      !Number.isInteger(candidate.start) ||
      !Number.isInteger(candidate.end) ||
      candidate.start < 0 ||
      candidate.end <= candidate.start ||
      candidate.end > text.length
    ) {
      return false
    }
    return (
      text.slice(candidate.start, candidate.end) ===
      `${promptRefPrefix(candidate.ref.kind)}${candidate.ref.label}`
    )
  })
  valid.sort((a, b) => a.start - b.start)
  const result: MobilePromptRef[] = []
  let previousEnd = 0
  let byteTotal = 0
  for (const candidate of valid) {
    if (result.length >= MAX_PROMPT_REFS) break
    if (candidate.start < previousEnd) continue
    // The gateway rejects the whole prompt over the aggregate byte budget;
    // keeping the token as plain text is friendlier than failing the send.
    const bytes =
      utf8ByteLength(candidate.ref.label) +
      utf8ByteLength(candidate.ref.uri) +
      utf8ByteLength(candidate.ref.text ?? '')
    if (byteTotal + bytes > MAX_PROMPT_REF_BYTES_TOTAL) continue
    byteTotal += bytes
    result.push({ ...candidate.ref, start: candidate.start, end: candidate.end })
    previousEnd = candidate.end
  }
  return result
}
