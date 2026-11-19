/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Left-hand table of contents for the settings editor: one entry per visible
 *  group with its (possibly search-filtered) setting count. Clicking scrolls
 *  the list to the group header; the active entry follows scroll position.
 *  Fixed width — hidden below 700px via CSS, mirroring VSCode's narrow mode.
 *
 *  Vim surface: a second flat list beside the settings rows. j/k moves the
 *  highlight, Enter/l jumps to the group and hands focus to the settings list.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useRef, useState, type RefObject } from 'react'
import { localize } from '@universe-editor/platform'
import { useFlatListNavigation } from '@universe-editor/workbench-ui'
import type { SettingsTocEntry } from '../../services/preferences/settingsFlatModel.js'
import styles from './SettingsEditor.module.css'

export interface SettingsTocProps {
  readonly entries: readonly SettingsTocEntry[]
  readonly activeId: string | undefined
  readonly onNavigate: (entry: SettingsTocEntry) => void
  /** Enter/l: jump to the group and hand focus to the settings rows. */
  readonly onActivate?: ((entry: SettingsTocEntry) => void) | undefined
}

export function SettingsToc({ entries, activeId, onNavigate, onActivate }: SettingsTocProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  // Keyboard cursor is local: the parent's `activeId` follows the scroll spy,
  // which must not overwrite a j/k highlight on every render.
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const safeIndex = Math.min(focusedIndex, entries.length - 1)

  const activate = useCallback(
    (index: number) => {
      const entry = entries[index]
      if (entry !== undefined) (onActivate ?? onNavigate)(entry)
    },
    [entries, onActivate, onNavigate],
  )

  const nav = useFlatListNavigation({
    count: entries.length,
    focusedIndex: safeIndex,
    onFocusChange: setFocusedIndex,
    getItemKey: useCallback((index: number) => entries[index]?.id ?? '', [entries]),
    getContainer: useCallback(() => containerRef.current, []),
    ariaLabel: localize('settings.tocAriaLabel', 'Settings categories'),
    onActivate: activate,
    // `l` is the Vim "enter" for a leaf; h has no meaning here.
    onMoveHorizontal: useCallback(
      (direction: 'left' | 'right', index: number) => {
        if (direction === 'right') activate(index)
      },
      [activate],
    ),
    vimSurfaceId: 'settings-toc',
  })

  const currentId = nav.hasFocus && safeIndex >= 0 ? entries[safeIndex]?.id : activeId

  return (
    <nav
      ref={containerRef as RefObject<HTMLElement | null>}
      className={styles['toc']}
      data-testid="settings-toc"
      {...nav.containerProps}
    >
      {entries.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          {...nav.getRowProps(index)}
          className={`${styles['tocItem']} ${entry.id === currentId ? styles['tocItemActive'] : ''}`}
          aria-current={entry.id === currentId}
          // The container owns focus; letting the button take it would break
          // the `focus: 'self'` Vim contract for the TOC surface.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onNavigate(entry)}
        >
          <span className={styles['tocLabel']}>{entry.title}</span>
          <span className={styles['tocCount']}>{entry.count}</span>
        </button>
      ))}
    </nav>
  )
}
