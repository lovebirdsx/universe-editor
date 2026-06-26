/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PlanCard — renders the agent's running plan as a live todo checklist (one of
 *  the streamed update variants). Each entry shows its status (pending /
 *  in_progress / completed) Copilot-style; the header tracks `done/total`
 *  progress and the collapsed summary surfaces the active task. Collapse is
 *  controlled by ChatBody (Alt+F / Ctrl+Alt+F). Stateless w.r.t. the session —
 *  `ChatBody` feeds entries from the unified timeline.
 *--------------------------------------------------------------------------------------------*/

import type { HTMLAttributes } from 'react'
import { localize } from '@universe-editor/platform'
import type { AcpPlanEntry } from '../../services/acp/acpSessionService.js'
import { CollapsibleSlot } from '@universe-editor/workbench-ui'
import { planEntryStatusIcon, planIcon } from './timelineIcons.js'
import styles from './agents.module.css'

const SUMMARY_MAX = 80

function clampLine(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX)}…` : firstLine
}

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
  const total = entries.length
  const done = entries.filter((e) => e.status === 'completed').length
  const active = entries.find((e) => e.status === 'in_progress')
  const planLabel = localize('acp.plan.title', 'Plan')

  const title = (
    <>
      <span className={styles['planTitle']}>{planLabel}</span>
      <span className={styles['planCount']}>
        {done}/{total}
      </span>
    </>
  )
  const summary = (
    <>
      <span className={styles['planTitle']}>{planLabel}</span>
      <span className={styles['planCount']}>
        {done}/{total}
      </span>
      {active ? (
        <span className={styles['planSummaryActive']}>{clampLine(active.content)}</span>
      ) : null}
    </>
  )

  return (
    <CollapsibleSlot
      as="li"
      icon={planIcon()}
      kindLabel={planLabel}
      title={title}
      summary={summary}
      collapsed={collapsed}
      onToggle={onToggle}
      rootProps={{ ...rootProps, 'data-testid': 'acp-plan' }}
    >
      <ul className={styles['planList']}>
        {entries.map((e, i) => (
          <li
            key={i}
            className={styles['planEntry']}
            data-priority={e.priority ?? 'normal'}
            data-status={e.status}
            data-testid="acp-plan-entry"
          >
            <span
              className={
                e.status === 'in_progress'
                  ? `${styles['planEntryIcon']} ${styles['spin']}`
                  : styles['planEntryIcon']
              }
              aria-hidden="true"
            >
              {planEntryStatusIcon(e.status)}
            </span>
            <span className={styles['planEntryText']}>{e.content}</span>
          </li>
        ))}
      </ul>
    </CollapsibleSlot>
  )
}
