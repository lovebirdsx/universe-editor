/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PlanCard — renders the agent's running plan (one of the streamed update
 *  variants). Collapsible header; plan rarely needs to dominate the chat
 *  surface so it stays compact. Stateless w.r.t. the session — `ChatBody`
 *  feeds entries from the unified timeline.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import type { AcpPlanEntry } from '../../services/acp/acpSessionService.js'
import styles from './agents.module.css'

export function PlanCard({ entries }: { entries: readonly AcpPlanEntry[] }) {
  const [open, setOpen] = useState(true)
  if (entries.length === 0) return null
  return (
    <section className={styles['planCard']} data-testid="acp-plan">
      <button
        type="button"
        className={styles['planHeader']}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles['planTitle']}>Plan</span>
        <span className={styles['planCount']}>{entries.length}</span>
        <span className={styles['planChevron']}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
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
      )}
    </section>
  )
}
