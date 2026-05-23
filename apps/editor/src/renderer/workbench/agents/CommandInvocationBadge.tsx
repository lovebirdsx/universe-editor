/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CommandInvocationBadge — compact pill for slash-command artifacts that
 *  agents replay back through user_message_chunk on session/load. We keep the
 *  raw text out of the markdown renderer and surface the structured fields
 *  parsed by `parseCommandWrappers` instead.
 *--------------------------------------------------------------------------------------------*/

import type { CommandInvocation } from '../../services/acp/commandWrapper.js'
import styles from './agents.module.css'

export function CommandInvocationBadge({ invocation }: { invocation: CommandInvocation }) {
  const header = invocation.args ? `${invocation.name} ${invocation.args}` : invocation.name
  return (
    <div className={styles['commandBadge']} data-testid="acp-command-badge">
      <div className={styles['commandBadgeHeader']}>
        <span className={styles['commandBadgeIcon']} aria-hidden>
          ⚡
        </span>
        <code className={styles['commandBadgeName']}>{header}</code>
      </div>
      {invocation.stdout && (
        <pre className={styles['commandBadgeStdout']} data-testid="acp-command-badge-stdout">
          {invocation.stdout}
        </pre>
      )}
    </div>
  )
}
