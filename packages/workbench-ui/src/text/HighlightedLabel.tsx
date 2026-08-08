import { cx } from '../atoms/cx.js'
import type { IMatch } from './wordMatching.js'
import styles from './HighlightedLabel.module.css'

export interface HighlightedLabelProps {
  text: string
  matches?: readonly IMatch[] | undefined
  className?: string | undefined
}

function normalizeMatches(text: string, matches: readonly IMatch[]): IMatch[] {
  const sorted = matches
    .filter((m) => m.end > m.start && m.start < text.length)
    .map((m) => ({ start: Math.max(0, m.start), end: Math.min(text.length, m.end) }))
    .filter((m) => m.end > m.start)
    .sort((a, b) => a.start - b.start)

  const merged: IMatch[] = []
  for (const m of sorted) {
    const last = merged[merged.length - 1]
    if (last && m.start <= last.end) {
      last.end = Math.max(last.end, m.end)
    } else {
      merged.push({ ...m })
    }
  }
  return merged
}

export function HighlightedLabel({ text, matches, className }: HighlightedLabelProps) {
  const spans = matches && matches.length > 0 ? normalizeMatches(text, matches) : []

  if (spans.length === 0) {
    return <span className={className}>{text}</span>
  }

  const parts: { key: number; matched: boolean; value: string }[] = []
  let cursor = 0
  let key = 0
  for (const span of spans) {
    if (span.start > cursor) {
      parts.push({ key: key++, matched: false, value: text.slice(cursor, span.start) })
    }
    parts.push({ key: key++, matched: true, value: text.slice(span.start, span.end) })
    cursor = span.end
  }
  if (cursor < text.length) {
    parts.push({ key: key++, matched: false, value: text.slice(cursor) })
  }

  return (
    <span className={className}>
      {parts.map((part) =>
        part.matched ? (
          <span key={part.key} className={cx(styles['match'])}>
            {part.value}
          </span>
        ) : (
          <span key={part.key}>{part.value}</span>
        ),
      )}
    </span>
  )
}
