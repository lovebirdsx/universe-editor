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
import { CollapsibleSlot } from './CollapsibleSlot.js'
import { InlineDiffPreview } from './InlineDiffPreview.js'
import { MessageContent } from './MessageContent.js'
import { TerminalOutput, ToolCallStatusIcon } from './ToolCallOutput.js'
import { toolKindIcon } from './timelineIcons.js'
import styles from './agents.module.css'

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
  collapsed: collapsedProp,
  onToggleCollapse,
}: {
  call: AcpToolCall
  extraClassName?: string
  dataTimelineKey?: string
  collapsed?: boolean
  onToggleCollapse?: () => void
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

  const body = isExecute ? (
    <>
      {diffs}
      {call.text.length > 0 && (
        <div className={styles['toolCallBody']}>
          <TerminalOutput text={call.text} />
        </div>
      )}
    </>
  ) : (
    <>
      {diffs}
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
      {children.map((c) =>
        c.kind === 'message' ? (
          <SubMessage key={c.id} message={c.message} />
        ) : (
          <ToolCallCard key={c.id} call={c.call} />
        ),
      )}
    </ul>
  )

  const titleNode = (
    <span className={styles['toolCallTitle']}>
      {call.title}
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
