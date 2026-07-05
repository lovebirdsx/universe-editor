/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PromptHistoryPopover — keyboard-navigable list of previously sent prompts shown
 *  above the textarea when the user presses ↑ on the first line. Pure presentation;
 *  navigation is driven by the owning PromptInput via PopoverList's activeIndex.
 *
 *  The popover floats ABOVE the input, so the list grows bottom-up: the newest
 *  entry sits at the bottom (nearest the input) and older entries stack upward.
 *  `entries`/`activeIndex` come in newest-first (index 0 = newest); we reverse for
 *  display and map indices both ways, so ↑ (older) moves the highlight visually
 *  up and ↓ (newer) moves it down — matching shell/terminal history.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { PopoverList } from '@universe-editor/workbench-ui'
import styles from './agents.module.css'

export interface PromptHistoryPopoverProps {
  readonly entries: readonly string[]
  readonly activeIndex: number
  readonly onSelect: (entry: string) => void
  readonly onHover: (index: number) => void
}

export function PromptHistoryPopover({
  entries,
  activeIndex,
  onSelect,
  onHover,
}: PromptHistoryPopoverProps) {
  // Display order is oldest→newest (top→bottom); logical order is newest-first.
  // toDisplay maps a logical index to its reversed position and back (the map is
  // its own inverse), so PromptInput keeps its newest-first index semantics.
  const toDisplay = (i: number): number => entries.length - 1 - i
  const displayEntries = entries.slice().reverse()

  return (
    <PopoverList
      items={displayEntries}
      activeIndex={toDisplay(activeIndex)}
      getKey={(_entry, i) => String(i)}
      onSelect={(entry) => onSelect(entry)}
      onHover={(i) => onHover(toDisplay(i))}
      className={styles['promptPopover']}
      data-testid="acp-history-popover"
      aria-label={localize('acp.history.popover.label', 'Input history')}
      renderItem={(entry) => (
        <span className={styles['historyEntry']} title={entry}>
          {entry}
        </span>
      )}
    />
  )
}
