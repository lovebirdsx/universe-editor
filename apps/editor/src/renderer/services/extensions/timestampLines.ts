export interface TimestampLinesResult {
  readonly text: string
  readonly atLineStart: boolean
}

export function timestampLines(
  text: string,
  atLineStart: boolean,
  linePrefix: () => string,
): TimestampLinesResult {
  if (text.length === 0) return { text, atLineStart }
  const parts: string[] = []
  for (const ch of text) {
    if (atLineStart) {
      parts.push(linePrefix())
      atLineStart = false
    }
    parts.push(ch)
    if (ch === '\n') atLineStart = true
  }
  return { text: parts.join(''), atLineStart }
}
