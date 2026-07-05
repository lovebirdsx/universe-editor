/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  UserMessageItem — renders a user message with a fixed max-height so a long
 *  prompt (pasted log, multi-block code) cannot dominate the timeline. When
 *  content exceeds the limit a chevron toggle reveals / hides the rest.
 *--------------------------------------------------------------------------------------------*/

import { memo, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { MessageContent } from './MessageContent.js'
import { useContentExpansion } from './chatContentExpansion.js'
import styles from './agents.module.css'

const COLLAPSED_MAX_PX = 160

export const UserMessageItem = memo(function UserMessageItem({
  blocks,
  contentKey,
}: {
  blocks: readonly ContentBlock[]
  contentKey?: string
}) {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [overflows, setOverflows] = useState(false)
  // Persist the expanded state (via the timeline's content-expansion store) so
  // it survives an unmount → remount cycle (session / tab switch, virtualization
  // scroll-off). Falls back to local state when used without a store or key.
  const store = useContentExpansion()
  const persisted = store !== null && contentKey !== undefined
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = persisted ? store.expandedKeys.has(contentKey) : localExpanded
  const toggle = () => {
    if (persisted) store.toggle(contentKey)
    else setLocalExpanded((v) => !v)
  }

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
          onClick={toggle}
          data-testid="acp-user-message-toggle"
        >
          <span aria-hidden="true">
            {expanded ? (
              <ChevronUp size={14} strokeWidth={1.75} />
            ) : (
              <ChevronDown size={14} strokeWidth={1.75} />
            )}
          </span>
          <span>{toggleLabel}</span>
        </button>
      )}
    </>
  )
})
