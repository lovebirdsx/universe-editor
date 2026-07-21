/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  InlineDiffPreview — compact line-level diff shown inside a ToolCallCard.
 *  Provides a "view full diff" affordance that delegates to the parent via
 *  onOpen (which in turn opens a DiffEditorInput in a new editor tab).
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { computeLineDiff, type DiffLine } from './lineDiff.js'
import styles from './agents.module.css'

const DEFAULT_COLLAPSED_LINES = 12
// A few leading context lines kept above the first change so it reads in context.
const LEADING_CONTEXT_LINES = 3

interface InlineDiffPreviewProps {
  readonly path: string
  readonly oldText: string
  readonly newText: string
  readonly onOpen: () => void
  /**
   * Open the source file for this diff (as opposed to {@link onOpen}, which opens
   * the diff view). Clicking the path invokes it; omitted → the path is static.
   */
  readonly onOpenPath?: () => void
}

/**
 * The slice of a diff to show while collapsed. Agents that emit whole-file diffs
 * (codex) put the first change deep below untouched context; a fixed `slice(0, n)`
 * would show only that leading context and hide the actual edit. Anchor the window
 * a few lines above the first change instead, so the collapsed card always opens on
 * the edit — agents that emit only the changed hunk (claude) keep starting at 0.
 */
export function collapsedDiffWindow(
  lineCount: number,
  firstChangeIndex: number,
  maxLines: number = DEFAULT_COLLAPSED_LINES,
): { readonly start: number; readonly count: number } {
  const count = Math.min(maxLines, lineCount)
  const anchored = Math.max(0, firstChangeIndex - LEADING_CONTEXT_LINES)
  const start = Math.min(anchored, lineCount - count)
  return { start, count }
}

export function InlineDiffPreview({
  path,
  oldText,
  newText,
  onOpen,
  onOpenPath,
}: InlineDiffPreviewProps) {
  const lines = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText])
  const [expanded, setExpanded] = useState(false)
  const firstChangeIndex = useMemo(() => {
    const i = lines.findIndex((l) => l.kind !== 'ctx')
    return i === -1 ? 0 : i
  }, [lines])
  const { start, count } = collapsedDiffWindow(lines.length, firstChangeIndex)
  const visible = expanded ? lines : lines.slice(start, start + count)
  const hiddenCount = expanded ? 0 : lines.length - visible.length

  return (
    <div className={styles['inlineDiff']} data-testid="acp-inline-diff">
      <div className={styles['inlineDiffHeader']}>
        {onOpenPath ? (
          <button
            type="button"
            className={styles['inlineDiffPathButton']}
            title={path}
            onClick={onOpenPath}
            data-testid="acp-inline-diff-path"
          >
            📝 {path}
          </button>
        ) : (
          <span className={styles['inlineDiffPath']} title={path}>
            📝 {path}
          </span>
        )}
        <button
          type="button"
          className={styles['inlineDiffOpen']}
          onClick={onOpen}
          title="查看完整修改"
          data-testid="acp-inline-diff-open"
        >
          <ArrowLeftRight size={14} aria-hidden />
        </button>
      </div>
      <pre className={styles['inlineDiffBody']}>
        {visible.map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            className={styles['inlineDiffExpand']}
            onClick={() => setExpanded(true)}
          >
            … 展开 {hiddenCount} 行
          </button>
        )}
      </pre>
    </div>
  )
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const cls =
    line.kind === 'add'
      ? styles['diffLineAdd']
      : line.kind === 'del'
        ? styles['diffLineDel']
        : styles['diffLineCtx']
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
  return (
    <span className={cls}>
      {sign} {line.text}
      {'\n'}
    </span>
  )
}
