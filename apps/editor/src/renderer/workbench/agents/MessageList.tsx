/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MessageList — renders the streaming message log for one session. Each
 *  message's structured `blocks` go through MessageContent for markdown,
 *  image, and resource-link rendering.
 *--------------------------------------------------------------------------------------------*/

import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import { MessageContent } from './MessageContent.js'
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
          <MessageContent blocks={m.blocks} />
        </li>
      ))}
    </ol>
  )
}
