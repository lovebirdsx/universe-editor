import type { MobilePlanEntry } from '@universe-editor/mobile-protocol'
import { useState } from 'react'
import { strings } from '../strings.js'

export interface PlanPanelProps {
  readonly plan: readonly MobilePlanEntry[]
}

export function PlanPanel({ plan }: PlanPanelProps) {
  const [expanded, setExpanded] = useState(false)
  if (plan.length === 0) return null
  const completed = plan.filter((entry) => entry.status === 'completed').length

  return (
    <section className="plan-panel" aria-label={strings.planTitle(completed, plan.length)}>
      <button
        type="button"
        className="plan-bar"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="plan-bar__title">{strings.planTitle(completed, plan.length)}</span>
        <span className="plan-bar__progress" aria-hidden="true">
          <span
            className="plan-bar__progress-fill"
            style={{ width: `${(completed / plan.length) * 100}%` }}
          />
        </span>
        <span className="plan-bar__chevron" aria-hidden="true">
          {expanded ? '▴' : '▾'}
        </span>
        <span className="visually-hidden">
          {expanded ? strings.planCollapse : strings.planExpand}
        </span>
      </button>
      {expanded && (
        <ol className="plan-list">
          {plan.map((entry, index) => (
            <li key={index} className={`plan-entry plan-entry--${entry.status}`}>
              <PlanStatusIcon status={entry.status} />
              <span className="plan-entry__content">{entry.content}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function PlanStatusIcon({ status }: { status: MobilePlanEntry['status'] }) {
  const label =
    status === 'completed'
      ? strings.planStatusCompleted
      : status === 'in_progress'
        ? strings.planStatusInProgress
        : strings.planStatusPending
  const glyph = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
  return (
    <span className={`plan-entry__icon plan-entry__icon--${status}`} role="img" aria-label={label}>
      {glyph}
    </span>
  )
}
