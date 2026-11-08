import {
  computeLineDiff,
  parseAnsi,
  type AnsiSegment,
  type DiffLine,
} from '@universe-editor/acp-view-model'
import type {
  MobileToolCallDetail,
  MobileToolCallDiffDetail,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Spinner } from '../components/Spinner.js'
import type { MobileClient } from '../state/mobileClient.js'
import { ToolCallDetailError } from '../state/toolCallDetailClient.js'
import { strings } from '../strings.js'

export interface ToolCallRowProps {
  readonly item: MobileTimelineToolCallItem
  readonly client: Pick<MobileClient, 'requestToolCallDetail'>
}

const KIND_GLYPHS: Readonly<Record<string, string>> = {
  read: '◫',
  search: '⌕',
  edit: '✎',
  execute: '▸',
  fetch: '⇩',
  think: '✧',
  switch_mode: '⇄',
  other: '•',
}

export function ToolCallRow({ item, client }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<MobileToolCallDetail | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const requestSeq = useRef(0)

  const load = (): void => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(undefined)
    void client.requestToolCallDetail(item.id).then(
      (next) => {
        if (seq !== requestSeq.current) return
        setDetail(next)
        setLoading(false)
      },
      (reason: unknown) => {
        if (seq !== requestSeq.current) return
        setLoading(false)
        setError(detailErrorText(reason))
      },
    )
  }

  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    if (next && !item.memoryTrimmed) load()
  }

  const diffStat = summarizeDiffs(item.diffs)

  return (
    <div className="tool-row" data-testid="tool-call-row" data-tool-status={item.status}>
      <button type="button" className="tool-row__header" aria-expanded={expanded} onClick={toggle}>
        <span className="tool-row__kind" aria-hidden="true">
          {KIND_GLYPHS[item.toolKind] ?? KIND_GLYPHS['other']}
        </span>
        <span className="tool-row__title">{item.title}</span>
        {diffStat !== undefined && (
          <span className="tool-row__diff">
            {strings.toolCallDiffStats(diffStat.added, diffStat.removed)}
          </span>
        )}
        <ToolStatusIcon status={item.status} />
        <span className="tool-row__chevron" aria-hidden="true">
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {expanded && (
        <div className="tool-row__body">
          {item.memoryTrimmed === true ? (
            <p className="muted-note">{strings.memoryTrimmed}</p>
          ) : loading ? (
            <div className="tool-row__loading">
              <Spinner size="small" label={strings.toolCallDetailLoading} />
              <span>{strings.toolCallDetailLoading}</span>
            </div>
          ) : error !== undefined ? (
            <div className="tool-row__error" role="alert">
              <span>{error}</span>
              <button type="button" className="text-button" onClick={load}>
                {strings.toolCallDetailRetry}
              </button>
            </div>
          ) : detail !== undefined ? (
            <ToolCallDetailBody detail={detail} toolKind={item.toolKind} />
          ) : (
            item.preview !== undefined && <pre className="tool-detail__text">{item.preview}</pre>
          )}
          {loading && item.preview !== undefined && (
            <pre className="tool-detail__text">{item.preview}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function ToolCallDetailBody({
  detail,
  toolKind,
}: {
  readonly detail: MobileToolCallDetail
  readonly toolKind: string
}) {
  const hasDiffs = detail.diffs.length > 0
  return (
    <div className="tool-detail">
      {detail.memoryTrimmed === true && <p className="muted-note">{strings.memoryTrimmed}</p>}
      {detail.text !== '' &&
        (toolKind === 'execute' ? (
          <AnsiText text={detail.text} />
        ) : (
          <pre className="tool-detail__text">{detail.text}</pre>
        ))}
      {hasDiffs &&
        detail.diffs.map((diff, index) => <DiffBlock key={`${diff.path}:${index}`} diff={diff} />)}
    </div>
  )
}

function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  return (
    <pre className="ansi-output">
      {segments.map((segment, index) => (
        <span key={index} style={ansiStyle(segment)}>
          {segment.text}
        </span>
      ))}
    </pre>
  )
}

function ansiStyle(segment: AnsiSegment): CSSProperties {
  const style: CSSProperties = {}
  if (segment.fg !== undefined) style.color = segment.fg
  if (segment.bg !== undefined) style.backgroundColor = segment.bg
  if (segment.bold) style.fontWeight = 600
  if (segment.dim) style.opacity = 0.7
  if (segment.italic) style.fontStyle = 'italic'
  if (segment.underline) style.textDecoration = 'underline'
  return style
}

function DiffBlock({ diff }: { readonly diff: MobileToolCallDiffDetail }) {
  const lines = useMemo(() => computeLineDiff(diff.oldText, diff.newText), [diff])
  const added = lines.filter((line) => line.kind === 'add').length
  const removed = lines.filter((line) => line.kind === 'del').length
  return (
    <div className="diff-block" data-testid="tool-call-diff">
      <div className="diff-block__header">
        <span className="diff-block__path">{diff.path}</span>
        <span className="diff-block__stats">{strings.toolCallDiffStats(added, removed)}</span>
      </div>
      <pre className="diff-block__body">
        {lines.map((line, index) => (
          <DiffLineRow key={index} line={line} />
        ))}
      </pre>
    </div>
  )
}

function DiffLineRow({ line }: { readonly line: DiffLine }) {
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
  return (
    <span className={`diff-line diff-line--${line.kind}`}>
      {sign} {line.text}
      {'\n'}
    </span>
  )
}

function ToolStatusIcon({ status }: { readonly status: string }): ReactNode {
  switch (status) {
    case 'pending':
    case 'in_progress':
      return <Spinner size="small" label={status} />
    case 'completed':
      return (
        <span className="tool-status tool-status--completed" role="img" aria-label={status}>
          ✓
        </span>
      )
    case 'failed':
      return (
        <span className="tool-status tool-status--failed" role="img" aria-label={status}>
          ✕
        </span>
      )
    case 'cancelled':
      return (
        <span className="tool-status tool-status--cancelled" role="img" aria-label={status}>
          ⊘
        </span>
      )
    default:
      return (
        <span className="tool-status" role="img" aria-label={status}>
          •
        </span>
      )
  }
}

function summarizeDiffs(
  diffs: MobileTimelineToolCallItem['diffs'],
): { readonly added: number; readonly removed: number } | undefined {
  if (diffs === undefined || diffs.length === 0) return undefined
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    added += diff.added
    removed += diff.removed
  }
  return { added, removed }
}

function detailErrorText(reason: unknown): string {
  if (reason instanceof ToolCallDetailError && reason.code === 'timeout') {
    return strings.toolCallDetailError
  }
  return strings.toolCallDetailError
}
