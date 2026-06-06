/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatPanel — the Copilot-style sidebar layout. The toolbar (sessions popover,
 *  New, switch-to-editor) lives in the view's title bar (AgentsViewToolbar);
 *  this component just hosts ChatBody, which renders the active session's stream
 *  and the prompt input.
 *--------------------------------------------------------------------------------------------*/

import { ChatBody } from './ChatBody.js'
import styles from './agents.module.css'

export function ChatPanel() {
  return (
    <div className={styles['chatPanel']} data-testid="acp-chat-panel">
      <ChatBody />
    </div>
  )
}
