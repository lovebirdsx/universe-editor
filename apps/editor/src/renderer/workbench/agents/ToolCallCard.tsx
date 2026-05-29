/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallCard / ToolCallList — renders the tool-call lane below the chat log.
 *
 *  Body rendering branches on `call.kind`:
 *   - `read`    → whole body collapsed by default; click the header to expand.
 *   - `execute` → command output rendered as an ANSI-coloured terminal with a
 *                 height cap + expand toggle.
 *   - other     → inline diff previews + markdown blocks (default behaviour).
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { IEditorService, URI } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import type {
  AcpToolCall,
  AcpToolCallDiff,
  IAcpSession,
} from '../../services/acp/acpSessionService.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { InlineDiffPreview } from './InlineDiffPreview.js'
import { MessageContent } from './MessageContent.js'
import { TerminalOutput, ToolCallStatusIcon } from './ToolCallOutput.js'
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

export function ToolCallCard({
  call,
  extraClassName,
  dataTimelineKey,
}: {
  call: AcpToolCall
  extraClassName?: string
  dataTimelineKey?: string
}) {
  const editorService = useService(IEditorService)
  const collapsible = call.kind === 'read'
  const [expanded, setExpanded] = useState(false)

  const openDiff = (diff: AcpToolCallDiff): void => {
    const uri = diff.path.includes('://') ? URI.parse(diff.path) : URI.file(diff.path)
    void editorService.openEditor(new DiffEditorInput(uri, diff.oldText, diff.newText))
  }

  const className = extraClassName
    ? `${styles['toolCallCard']} ${extraClassName}`
    : styles['toolCallCard']

  const showBody = !collapsible || expanded
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

  return (
    <li
      className={className}
      data-status={call.status}
      data-kind={call.kind}
      {...(dataTimelineKey !== undefined ? { 'data-timeline-key': dataTimelineKey } : {})}
    >
      {collapsible ? (
        <button
          type="button"
          className={styles['toolCallHeaderButton']}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="acp-toolcall-read-toggle"
        >
          <span className={styles['toolCallChevron']} aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className={styles['toolCallKind']}>{call.kind}</span>
          <span className={styles['toolCallTitle']}>{call.title}</span>
          <ToolCallStatusIcon status={call.status} />
        </button>
      ) : (
        <header className={styles['toolCallHeader']}>
          <span className={styles['toolCallKind']}>{call.kind}</span>
          <span className={styles['toolCallTitle']}>{call.title}</span>
          <ToolCallStatusIcon status={call.status} />
        </header>
      )}
      {showBody && body}
    </li>
  )
}
