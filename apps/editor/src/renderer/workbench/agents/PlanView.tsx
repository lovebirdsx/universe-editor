/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PlanCard — renders the agent's running plan (one of the streamed update
 *  variants). Collapse is controlled by ChatBody (Alt+F / Ctrl+Alt+F); plan
 *  rarely needs to dominate the chat surface so it stays compact. Stateless
 *  w.r.t. the session — `ChatBody` feeds entries from the unified timeline.
 *--------------------------------------------------------------------------------------------*/

import type { HTMLAttributes } from 'react'
import type { AcpPlanEntry } from '../../services/acp/acpSessionService.js'
import { CollapsibleSlot } from './CollapsibleSlot.js'
import { planIcon } from './timelineIcons.js'
import styles from './agents.module.css'

export function PlanCard({
  entries,
  collapsed,
  onToggle,
  rootProps,
}: {
  entries: readonly AcpPlanEntry[]
  collapsed: boolean
  onToggle: () => void
  rootProps?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string>
}) {
  if (entries.length === 0) return null
  const heading = (
    <>
      <span className={styles['planTitle']}>Plan</span>
      <span className={styles['planCount']}>{entries.length}</span>
    </>
  )
  return (
    <CollapsibleSlot
      as="li"
      icon={planIcon()}
      kindLabel="Plan"
      title={heading}
      summary={heading}
      collapsed={collapsed}
      onToggle={onToggle}
      rootProps={{ ...rootProps, 'data-testid': 'acp-plan' }}
    >
      <ol className={styles['planList']}>
        {entries.map((e, i) => (
          <li
            key={i}
            className={styles['planEntry']}
            data-priority={e.priority ?? 'normal'}
            data-testid="acp-plan-entry"
          >
            {e.content}
          </li>
        ))}
      </ol>
    </CollapsibleSlot>
  )
}
