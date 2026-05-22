/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MentionPopover — inline autocomplete shown above the prompt textarea
 *  while the user types `@<query>`. Mirrors SlashCommandPopover: pure
 *  presentation, navigation/acceptance driven by <PromptInput> through
 *  keyboard handlers on the textarea so focus never leaves the input.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { localize } from '@universe-editor/platform'
import type { MentionFileEntry } from '../../services/acp/mentionFileSearch.js'
import styles from './agents.module.css'

export interface MentionPopoverProps {
  readonly entries: readonly MentionFileEntry[]
  readonly activeIndex: number
  readonly loading?: boolean
  readonly onSelect: (entry: MentionFileEntry) => void
  readonly onHover: (index: number) => void
}

export function MentionPopover({
  entries,
  activeIndex,
  loading,
  onSelect,
  onHover,
}: MentionPopoverProps) {
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = listRef.current
    if (!root) return
    const el = root.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (loading && entries.length === 0) {
    return (
      <div className={styles['slashPopover']} role="listbox" data-testid="acp-mention-popover">
        <div className={styles['slashEmpty']}>
          {localize('acp.mention.loading', 'Scanning files…')}
        </div>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className={styles['slashPopover']} role="listbox" data-testid="acp-mention-popover">
        <div className={styles['slashEmpty']}>
          {localize('acp.mention.empty', 'No matching files')}
        </div>
      </div>
    )
  }

  return (
    <div
      className={styles['slashPopover']}
      role="listbox"
      ref={listRef}
      data-testid="acp-mention-popover"
    >
      {entries.map((e, i) => (
        <div
          key={e.uri}
          role="option"
          aria-selected={i === activeIndex}
          data-active={i === activeIndex}
          className={styles['slashItem']}
          onMouseDown={(ev) => {
            // Keep textarea focus.
            ev.preventDefault()
            onSelect(e)
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className={styles['slashName']}>{e.name}</span>
          <span className={styles['slashDesc']}>{e.relPath}</span>
        </div>
      ))}
    </div>
  )
}
