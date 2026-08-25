/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PanelSection — the top-level collapsible group of an AI settings panel, plus the
 *  toggle rule its collapse state has to follow. Shared by the providers panel and
 *  the model knowledge panel.
 *
 *  Deliberately not `CardSection`: that one is the *inner* fold of a provider card
 *  (summary line, actions slot, its own storage key space).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { StorageScope, type IStorageService } from '@universe-editor/platform'
import styles from './AiSettingsEditor.module.css'

export function PanelSection({
  title,
  collapsed,
  onToggle,
  children,
}: {
  readonly title: string
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
}) {
  return (
    <section className={styles['section']}>
      <button
        type="button"
        className={styles['sectionHeader']}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? (
          <ChevronRight size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        ) : (
          <ChevronDown size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        )}
        <span className={styles['sectionTitle']}>{title}</span>
      </button>
      {!collapsed && <div className={styles['sectionBody']}>{children}</div>}
    </section>
  )
}

/**
 * The collapse-state toggle for one panel's whole record, persisted under a single
 * storage key.
 *
 * `defaultCollapsed` is not decoration: storage holds only the keys the user has
 * actually toggled, so a section that starts collapsed would otherwise read
 * `undefined`, flip to `true`, and stay collapsed — a first click that visibly does
 * nothing. Toggling the *effective* value keeps the stored model sparse (no
 * pre-seeded defaults, no migration) while every default behaves.
 */
export function useCollapseToggle(
  storage: IStorageService,
  storageKey: string,
  setCollapsed: (
    update: (prev: Readonly<Record<string, boolean>>) => Record<string, boolean>,
  ) => void,
): (key: string, defaultCollapsed: boolean) => void {
  return useCallback(
    (key: string, defaultCollapsed: boolean) => {
      setCollapsed((prev) => {
        const next = { ...prev, [key]: !(prev[key] ?? defaultCollapsed) }
        void storage.set(storageKey, next, StorageScope.GLOBAL)
        return next
      })
    },
    [setCollapsed, storage, storageKey],
  )
}
