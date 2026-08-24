/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CardSection — a collapsible group inside a provider card, for the parts of an
 *  entry that are configured once and then only read: where prices come from,
 *  where account usage comes from, which protocols and models exist.
 *
 *  The summary stays visible in both states, which is the point: collapsed, it is
 *  the only thing telling the user how this section is configured; expanded, it
 *  keeps the answer on screen while they edit the form that produced it. That is
 *  also why this is not `CollapsibleSlot` — that one swaps title for summary,
 *  carries an ACP-specific test id, and has no room for the header actions
 *  (Refresh, "Saved") these sections need.
 *
 *  Collapse is controlled by the panel so it can be persisted per provider.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import styles from '../AiSettingsEditor.module.css'

export interface CardSectionProps {
  readonly title: string
  /** Configuration state at a glance — shown collapsed *and* expanded. */
  readonly summary?: ReactNode
  /** Header-right slot (refresh buttons, "Saved" flag). Clicks do not toggle. */
  readonly actions?: ReactNode
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
  readonly testId?: string | undefined
}

export function CardSection({
  title,
  summary,
  actions,
  collapsed,
  onToggle,
  children,
  testId,
}: CardSectionProps) {
  return (
    <section
      className={styles['cardSection']}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
    >
      <div className={styles['cardSectionHeader']}>
        <button
          type="button"
          className={styles['cardSectionToggle']}
          aria-expanded={!collapsed}
          aria-label={localize('aiModels.cardSection.toggle', 'Toggle {title}', { title })}
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight size={14} strokeWidth={1.75} className={styles['cardIcon']} />
          ) : (
            <ChevronDown size={14} strokeWidth={1.75} className={styles['cardIcon']} />
          )}
          <span className={styles['cardSectionTitle']}>{title}</span>
          {summary !== undefined && <span className={styles['cardSectionSummary']}>{summary}</span>}
        </button>
        {actions !== undefined && <div className={styles['cardSectionActions']}>{actions}</div>}
      </div>
      {!collapsed && <div className={styles['cardSectionBody']}>{children}</div>}
    </section>
  )
}
