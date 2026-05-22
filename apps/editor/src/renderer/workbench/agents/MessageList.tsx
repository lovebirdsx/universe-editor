/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MessageList — renders the streaming message log for one session. Plain text
 *  rendering for v1; markdown rendering can be layered in later via a dedicated
 *  helper without changing the data flow.
 *--------------------------------------------------------------------------------------------*/

import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import styles from './agents.module.css'

export function MessageList({ session }: { session: IAcpSession }) {
  const messages = useObservable(session.messages)

  return (
    <ol className={styles['messageList']} data-testid="acp-message-list">
      {messages.map((m) => (
        <li
          key={m.id}
          className={styles['messageItem']}
          data-role={m.role}
          data-testid={`acp-message-${m.role}`}
        >
          <span className={styles['messageRole']}>{m.role}</span>
          <pre className={styles['messageText']}>{m.text}</pre>
        </li>
      ))}
    </ol>
  )
}
