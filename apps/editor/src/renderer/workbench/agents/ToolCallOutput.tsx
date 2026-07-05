/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallOutput — building blocks for the tool-call card:
 *   - TerminalOutput: renders `execute` command output with ANSI colours, a
 *     height cap, and an expand / collapse toggle (mirrors UserMessageItem).
 *   - ToolCallStatusIcon: status text → lucide icon, spinning while in flight.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, ChevronDown, ChevronUp, CircleX, Loader2 } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { parseAnsi, type AnsiSegment } from '../../services/acp/ansi.js'
import type { AcpToolCallStatus } from '../../services/acp/acpSessionService.js'
import { useContentExpansion } from './chatContentExpansion.js'
import styles from './agents.module.css'

const COLLAPSED_MAX_PX = 240

export function TerminalOutput({ text, contentKey }: { text: string; contentKey?: string }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  const innerRef = useRef<HTMLPreElement | null>(null)
  const [overflows, setOverflows] = useState(false)
  // Persist expansion across unmount → remount (session / tab switch,
  // virtualization scroll-off); local fallback when no store/key is threaded.
  const store = useContentExpansion()
  const persisted = store !== null && contentKey !== undefined
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = persisted ? store.expandedKeys.has(contentKey) : localExpanded
  const toggle = () => {
    if (persisted) store.toggle(contentKey)
    else setLocalExpanded((v) => !v)
  }

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > COLLAPSED_MAX_PX + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const collapsed = overflows && !expanded
  const toggleLabel = expanded
    ? localize('acp.terminal.collapse', 'Collapse')
    : localize('acp.terminal.expand', 'Expand')

  return (
    <>
      <div
        className={styles['terminalOutput']}
        data-collapsed={collapsed ? 'true' : 'false'}
        data-overflow={overflows ? 'true' : 'false'}
        data-testid="acp-terminal-output"
      >
        <pre className={styles['terminalOutputPre']} ref={innerRef}>
          {segments.map((seg, i) => (
            <AnsiSpan key={i} segment={seg} />
          ))}
        </pre>
      </div>
      {overflows && (
        <button
          type="button"
          className={styles['terminalOutputToggle']}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          onClick={toggle}
          data-testid="acp-terminal-output-toggle"
        >
          <span aria-hidden="true">
            {expanded ? (
              <ChevronUp size={14} strokeWidth={1.75} />
            ) : (
              <ChevronDown size={14} strokeWidth={1.75} />
            )}
          </span>
          <span>{toggleLabel}</span>
        </button>
      )}
    </>
  )
}

function AnsiSpan({ segment }: { segment: AnsiSegment }) {
  const style: CSSProperties = {}
  if (segment.fg !== undefined) style.color = segment.fg
  if (segment.bg !== undefined) style.backgroundColor = segment.bg
  if (segment.bold) style.fontWeight = 600
  if (segment.dim) style.opacity = 0.7
  if (segment.italic) style.fontStyle = 'italic'
  if (segment.underline) style.textDecoration = 'underline'
  return <span style={style}>{segment.text}</span>
}

export function ToolCallStatusIcon({ status }: { status: AcpToolCallStatus }) {
  const className = `${styles['toolCallStatusIcon']} ${styles[`toolCallStatusIcon_${status}`] ?? ''}`
  const common = { size: 14, 'aria-label': status, role: 'img' as const }
  switch (status) {
    case 'pending':
    case 'in_progress':
      return <Loader2 {...common} className={`${className} ${styles['spin']}`} />
    case 'completed':
      return <Check {...common} className={className} />
    case 'failed':
      return <CircleX {...common} className={className} />
  }
}
