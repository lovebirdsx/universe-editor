/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallOutput — building blocks for the tool-call card:
 *   - TerminalOutput: renders `execute` command output with ANSI colours, a
 *     height cap, and an expand / collapse toggle (mirrors UserMessageItem).
 *   - ToolCallStatusIcon: status text → lucide icon, spinning while in flight.
 *--------------------------------------------------------------------------------------------*/

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Check, ChevronDown, ChevronRight, ChevronUp, CircleX, Loader2 } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { parseAnsi, type AnsiSegment } from '../../services/acp/ansi.js'
import type { AcpToolCallStatus } from '../../services/acp/acpSessionService.js'
import { useContentExpansion } from './chatContentExpansion.js'
import styles from './agents.module.css'

const COLLAPSED_MAX_PX = 240

// Synchronous first-render estimate of whether the terminal body exceeds the
// collapsed cap, from the text alone (no DOM measurement). WHY this matters: the
// row must render at its FINAL (clamped) height on the very first paint. In
// virtual mode the timeline remounts a row every time it scrolls back into the
// overscan window; if the first render were full-height (overflows=false) and an
// async effect clamped it afterwards, the virtualizer's measureElement would
// record the tall height at commit, then the clamp would fire a size-change
// correction — and because the correction re-mounts the row it flashes tall
// again, an endless scrollTop oscillation (the reported jitter). Seeding
// overflows from a stable pure function of the text keeps the committed height
// identical on every mount, so no correction fires. The layout-effect below
// still refines it, but for typical output the estimate already agrees.
const TERMINAL_LINE_PX = 16
const TERMINAL_WRAP_COLS = 80
const TERMINAL_VPAD_PX = 8

function estimateTerminalOverflow(text: string): boolean {
  let lines = 0
  for (const seg of text.split('\n')) {
    lines += Math.max(1, Math.ceil(seg.length / TERMINAL_WRAP_COLS))
    if (lines * TERMINAL_LINE_PX + TERMINAL_VPAD_PX > COLLAPSED_MAX_PX) return true
  }
  return lines * TERMINAL_LINE_PX + TERMINAL_VPAD_PX > COLLAPSED_MAX_PX
}

/**
 * A labeled, collapsible sub-section inside a tool-call card (e.g. the MCP
 * card's Input / Output panels). Initial expansion is seeded from the caller
 * (config-driven); the toggle is local state so folding a section stays put for
 * the card's lifetime.
 */
export function ToolCallSection({
  label,
  defaultExpanded,
  children,
  testId,
}: {
  label: string
  defaultExpanded: boolean
  children: ReactNode
  testId?: string
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <div className={styles['toolCallSection']} data-testid={testId}>
      <button
        type="button"
        className={styles['toolCallSectionHeader']}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={styles['toolCallSectionChevron']} aria-hidden="true">
          {expanded ? (
            <ChevronDown size={12} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={12} strokeWidth={1.75} />
          )}
        </span>
        <span className={styles['toolCallSectionLabel']}>{label}</span>
      </button>
      {expanded && <div className={styles['toolCallSectionBody']}>{children}</div>}
    </div>
  )
}

export function TerminalOutput({ text, contentKey }: { text: string; contentKey?: string }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  const innerRef = useRef<HTMLPreElement | null>(null)
  // Seed from a synchronous estimate (not `false`) so the FIRST render already
  // clamps when the body is long — see estimateTerminalOverflow. A false→true
  // flip after mount would change the row's measured height post-commit and, in
  // the virtualized timeline, drive an endless scroll correction loop.
  const [overflows, setOverflows] = useState(() => estimateTerminalOverflow(text))
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

  // Refine the estimate against the real rendered height, and keep tracking async
  // growth (ANSI colouring, font load). useLayoutEffect (not useEffect) so the
  // correction lands before the browser paints — no visible tall→short flash, and
  // the virtualizer measures the settled height. Only flip state when it actually
  // changes to avoid a redundant re-render.
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const measure = () => {
      const next = el.scrollHeight > COLLAPSED_MAX_PX + 1
      setOverflows((prev) => (prev === next ? prev : next))
    }
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
