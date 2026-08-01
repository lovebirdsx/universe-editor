/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Left-hand table of contents for the settings editor: one entry per visible
 *  group with its (possibly search-filtered) setting count. Clicking scrolls
 *  the list to the group header; the active entry follows scroll position.
 *  Fixed width — hidden below 700px via CSS, mirroring VSCode's narrow mode.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsTocEntry } from '../../services/preferences/settingsFlatModel.js'
import styles from './SettingsEditor.module.css'

export interface SettingsTocProps {
  readonly entries: readonly SettingsTocEntry[]
  readonly activeId: string | undefined
  readonly onNavigate: (entry: SettingsTocEntry) => void
}

export function SettingsToc({ entries, activeId, onNavigate }: SettingsTocProps) {
  return (
    <nav className={styles['toc']} aria-label="Settings categories" data-testid="settings-toc">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`${styles['tocItem']} ${entry.id === activeId ? styles['tocItemActive'] : ''}`}
          onClick={() => onNavigate(entry)}
        >
          <span className={styles['tocLabel']}>{entry.title}</span>
          <span className={styles['tocCount']}>{entry.count}</span>
        </button>
      ))}
    </nav>
  )
}
