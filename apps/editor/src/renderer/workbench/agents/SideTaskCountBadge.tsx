/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SideTaskCountBadge — a non-interactive hint for the number of direct side
 *  tasks a session owns. Renders nothing at zero so ordinary sessions keep
 *  their original tab / row shape. The count semantics match the parent chat's
 *  SideTasksBar popover (`directSideTaskChildren`), and callers pass the number
 *  in — this component owns no services.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { GitBranch } from 'lucide-react'
import styles from './agents.module.css'

export function SideTaskCountBadge({ count, testId }: { count: number; testId: string }) {
  if (count <= 0) return null
  const label = localize('acp.sideTask.count', 'Side Tasks ({count})', { count })
  return (
    <span
      className={styles['sideTaskCount']}
      role="img"
      aria-label={label}
      data-testid={testId}
      data-tooltip={label}
    >
      <GitBranch size={11} strokeWidth={1.75} aria-hidden="true" />
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
    </span>
  )
}
