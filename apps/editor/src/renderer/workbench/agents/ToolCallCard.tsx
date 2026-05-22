/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallCard / ToolCallList — renders the tool-call lane below the chat log.
 *--------------------------------------------------------------------------------------------*/

import { useObservable } from '../useService.js'
import type { AcpToolCall, IAcpSession } from '../../services/acp/acpSessionService.js'
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

export function ToolCallCard({ call }: { call: AcpToolCall }) {
  return (
    <li className={styles['toolCallCard']} data-status={call.status}>
      <header className={styles['toolCallHeader']}>
        <span className={styles['toolCallKind']}>{call.kind}</span>
        <span className={styles['toolCallTitle']}>{call.title}</span>
        <span className={styles['toolCallStatus']}>{call.status}</span>
      </header>
      {call.blocks.length > 0 && (
        <div className={styles['toolCallBody']}>
          <MessageContent blocks={call.blocks} />
        </div>
      )}
    </li>
  )
}
