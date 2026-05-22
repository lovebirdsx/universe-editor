/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PlanView — renders the agent's running plan (one of the streamed update
 *  variants). Collapsed by default once the agent declares it; the plan rarely
 *  needs to dominate the chat surface.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import styles from './agents.module.css'

export function PlanView({ session }: { session: IAcpSession }) {
  const entries = useObservable(session.plan)
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
