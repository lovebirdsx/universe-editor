/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallCard / ToolCallList — renders the tool-call lane below the chat log.
 *
 *  Body rendering branches on `call.kind`:
 *   - `read` / `search` → whole body collapsed by default; click header to expand.
 *   - `execute` → command output rendered as an ANSI-coloured terminal with a
 *                 height cap + expand toggle.
 *   - other     → inline diff previews + markdown blocks (default behaviour).
 *--------------------------------------------------------------------------------------------*/

import { memo, useState } from 'react'
import { IEditorService, URI } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import type {
  AcpMessage,
  AcpToolCall,
  AcpToolCallDiff,
  IAcpSession,
} from '../../services/acp/acpSessionService.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { CollapsibleSlot } from '@universe-editor/workbench-ui'
import { InlineDiffPreview } from './InlineDiffPreview.js'
import { MessageContent } from './MessageContent.js'
import { TerminalOutput, ToolCallStatusIcon } from './ToolCallOutput.js'
import { toolKindIcon } from './timelineIcons.js'
import { deriveToolCallDisplay } from './toolCallDisplay.js'
import { buildStickyKey } from './stickyScroll.js'
import { resolveCollapsed, type CollapseState } from './timelineCollapse.js'
import styles from './agents.module.css'

/**
 * Threads the unified collapse store into a controlled tool-call subtree so the
 * sticky overlay (and Alt+F) can fold nested sub-agent cards via composite keys.
 * Absent for the standalone {@link ToolCallList}, which keeps self-managed state.
 */
export interface SubtreeCollapse {
  /** This card's own (composite) sticky key. */
  readonly stickyKey: string
  /** This card's own nesting depth. */
  readonly depth: number
  readonly collapse: CollapseState
  readonly toggle: (key: string) => void
}

export function ToolCallList({ session }: { session: IAcpSession }) {
  const calls = useObservable(session.toolCalls)
  if (calls.length === 0) return null
  return (
    <ul className={styles['toolCallList']} data-testid="acp-toolcall-list">
      {calls.map((c) => (
        <ToolCallCard key={c.id} call={c} />
      ))}
    </ul>
  )
}

export const ToolCallCard = memo(function ToolCallCard({
  call,
  extraClassName,
  dataTimelineKey,
  dataStickyKey,
  dataStickyDepth,
  collapsed: collapsedProp,
  onToggleCollapse,
  subtreeCollapse,
}: {
  call: AcpToolCall
  extraClassName?: string
  dataTimelineKey?: string
  dataStickyKey?: string
  dataStickyDepth?: number
  collapsed?: boolean
  onToggleCollapse?: () => void
  subtreeCollapse?: SubtreeCollapse
}) {
  const editorService = useService(IEditorService)
  // Controlled by the timeline (Alt+F / Ctrl+Alt+F); falls back to self-managed
  // state when used standalone (ToolCallList). read/search start collapsed.
  const controlled = collapsedProp !== undefined
  const [internalCollapsed, setInternalCollapsed] = useState(
    () => call.kind === 'read' || call.kind === 'search',
  )
  const collapsed = controlled ? collapsedProp : internalCollapsed
  const onToggle = controlled
    ? (onToggleCollapse ?? (() => {}))
    : () => setInternalCollapsed((v) => !v)

  const openDiff = (diff: AcpToolCallDiff): void => {
    const uri = diff.path.includes('://') ? URI.parse(diff.path) : URI.file(diff.path)
    void editorService.openEditor(new DiffEditorInput(uri, diff.oldText, diff.newText))
  }

  const className = extraClassName
    ? `${styles['toolCallCard']} ${extraClassName}`
    : styles['toolCallCard']

  const hasDiffs = call.diffs.length > 0
  const isExecute = call.kind === 'execute'
  const display = deriveToolCallDisplay(call)

  const diffs = hasDiffs && (
    <div className={styles['toolCallDiffs']}>
      {call.diffs.map((d, i) => (
        <InlineDiffPreview
          key={`${d.path}-${i}`}
          path={d.path}
          oldText={d.oldText}
          newText={d.newText}
          onOpen={() => openDiff(d)}
        />
      ))}
    </div>
  )

  const commandDetail = display.subtitle !== undefined && (
    <div className={styles['toolCallCommand']}>
      <code>{display.subtitle}</code>
    </div>
  )

  const body = isExecute ? (
    <>
      {diffs}
      {commandDetail}
      {call.text.length > 0 && (
        <div className={styles['toolCallBody']}>
          <TerminalOutput
            text={call.text}
            {...(dataStickyKey !== undefined ? { contentKey: `term:${dataStickyKey}` } : {})}
          />
        </div>
      )}
    </>
  ) : (
    <>
      {diffs}
      {commandDetail}
      {call.blocks.length > 0 && (
        <div className={styles['toolCallBody']}>
          <MessageContent blocks={call.blocks} />
        </div>
      )}
    </>
  )

  // Sub-agent timeline (Task tool): the spawned agent's messages / tool calls,
  // folded inside this card. CollapsibleSlot only mounts the body when expanded,
  // so this stays hidden until the user opens the card.
  const children = call.children ?? []
  const childTimeline = children.length > 0 && (
    <ul className={styles['toolCallChildren']} data-testid="acp-subagent-timeline">
      {children.map((c) => {
        if (c.kind === 'message') return <SubMessage key={c.id} message={c.message} />
        if (!subtreeCollapse) return <ToolCallCard key={c.id} call={c.call} />
        const childKey = buildStickyKey(subtreeCollapse.stickyKey, c)
        const childDepth = subtreeCollapse.depth + 1
        return (
          <ToolCallCard
            key={c.id}
            call={c.call}
            collapsed={resolveCollapsed(childKey, c, subtreeCollapse.collapse)}
            onToggleCollapse={() => subtreeCollapse.toggle(childKey)}
            subtreeCollapse={{
              stickyKey: childKey,
              depth: childDepth,
              collapse: subtreeCollapse.collapse,
              toggle: subtreeCollapse.toggle,
            }}
            dataStickyKey={childKey}
            dataStickyDepth={childDepth}
          />
        )
      })}
    </ul>
  )

  const titleNode = (
    <span className={styles['toolCallTitle']}>
      {display.title}
      {call.mcpServer !== undefined && (
        <span className={styles['mcpBadge']} title={`MCP server: ${call.mcpServer}`}>
          MCP · {call.mcpServer}
        </span>
      )}
    </span>
  )

  return (
    <CollapsibleSlot
      as="li"
      icon={toolKindIcon(call.kind)}
      kindLabel={call.kind}
      title={titleNode}
      summary={titleNode}
      statusIcon={<ToolCallStatusIcon status={call.status} />}
      collapsed={collapsed}
      onToggle={onToggle}
      rootProps={{
        className,
        'data-status': call.status,
        'data-kind': call.kind,
        ...(dataTimelineKey !== undefined ? { 'data-timeline-key': dataTimelineKey } : {}),
        ...(dataStickyKey !== undefined ? { 'data-sticky-key': dataStickyKey } : {}),
        ...(dataStickyDepth !== undefined ? { 'data-sticky-depth': String(dataStickyDepth) } : {}),
      }}
    >
      {body}
      {childTimeline}
    </CollapsibleSlot>
  )
})

/** A single sub-agent message rendered inside a parent tool call's child timeline. */
function SubMessage({ message }: { message: AcpMessage }) {
  return (
    <li
      className={styles['subMessage']}
      data-role={message.role}
      data-testid="acp-subagent-message"
    >
      <MessageContent blocks={message.blocks} />
    </li>
  )
}
