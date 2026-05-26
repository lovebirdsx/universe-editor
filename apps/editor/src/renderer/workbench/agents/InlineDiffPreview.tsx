/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  InlineDiffPreview — compact line-level diff shown inside a ToolCallCard.
 *  Provides a "view full diff" affordance that delegates to the parent via
 *  onOpen (which in turn opens a DiffEditorInput in a new editor tab).
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react'
import { computeLineDiff, type DiffLine } from './lineDiff.js'
import styles from './agents.module.css'

const DEFAULT_COLLAPSED_LINES = 12

interface InlineDiffPreviewProps {
  readonly path: string
  readonly oldText: string
  readonly newText: string
  readonly onOpen: () => void
}

export function InlineDiffPreview({ path, oldText, newText, onOpen }: InlineDiffPreviewProps) {
  const lines = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText])
  const [expanded, setExpanded] = useState(false)
  const collapsedCount = Math.min(DEFAULT_COLLAPSED_LINES, lines.length)
  const visible = expanded ? lines : lines.slice(0, collapsedCount)
  const hiddenCount = lines.length - visible.length

  return (
    <div className={styles['inlineDiff']} data-testid="acp-inline-diff">
      <div className={styles['inlineDiffHeader']}>
        <span className={styles['inlineDiffPath']} title={path}>
          📝 {path}
        </span>
        <button
          type="button"
          className={styles['inlineDiffOpen']}
          onClick={onOpen}
          data-testid="acp-inline-diff-open"
        >
          查看完整修改
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
