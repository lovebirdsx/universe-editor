/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallCard / ToolCallList — renders the tool-call lane below the chat log.
 *--------------------------------------------------------------------------------------------*/

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

  const openDiff = (diff: AcpToolCallDiff): void => {
    const uri = diff.path.includes('://') ? URI.parse(diff.path) : URI.file(diff.path)
    void editorService.openEditor(new DiffEditorInput(uri, diff.oldText, diff.newText))
  }

  const className = extraClassName
    ? `${styles['toolCallCard']} ${extraClassName}`
    : styles['toolCallCard']

  return (
    <li
      className={className}
      data-status={call.status}
      {...(dataTimelineKey !== undefined ? { 'data-timeline-key': dataTimelineKey } : {})}
    >
      <header className={styles['toolCallHeader']}>
        <span className={styles['toolCallKind']}>{call.kind}</span>
        <span className={styles['toolCallTitle']}>{call.title}</span>
        <span className={styles['toolCallStatus']}>{call.status}</span>
      </header>
      {call.diffs.length > 0 && (
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
      )}
      {call.blocks.length > 0 && (
        <div className={styles['toolCallBody']}>
          <MessageContent blocks={call.blocks} />
        </div>
      )}
    </li>
  )
}
