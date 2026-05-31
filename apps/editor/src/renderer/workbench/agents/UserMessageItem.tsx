/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  UserMessageItem — renders a user message with a fixed max-height so a long
 *  prompt (pasted log, multi-block code) cannot dominate the timeline. When
 *  content exceeds the limit a chevron toggle reveals / hides the rest.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { localize } from '@universe-editor/platform'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { MessageContent } from './MessageContent.js'
import styles from './agents.module.css'

const COLLAPSED_MAX_PX = 160

export function UserMessageItem({ blocks }: { blocks: readonly ContentBlock[] }) {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > COLLAPSED_MAX_PX + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const collapsed = overflows && !expanded
  const showToggle = overflows
  const toggleLabel = expanded
    ? localize('acp.userMessage.collapse', 'Collapse')
    : localize('acp.userMessage.expand', 'Expand')

  return (
    <>
      <div
        className={styles['userMessageBody']}
        data-collapsed={collapsed ? 'true' : 'false'}
        data-overflow={overflows ? 'true' : 'false'}
        data-testid="acp-user-message-body"
      >
        <div ref={innerRef}>
          <MessageContent blocks={blocks} />
        </div>
      </div>
      {showToggle && (
        <button
          type="button"
          className={styles['userMessageToggle']}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          onClick={() => setExpanded((v) => !v)}
          data-testid="acp-user-message-toggle"
        >
          <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
          <span>{toggleLabel}</span>
        </button>
      )}
    </>
  )
}
