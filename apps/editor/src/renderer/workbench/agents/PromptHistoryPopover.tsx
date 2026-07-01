/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PromptHistoryPopover — keyboard-navigable list of previously sent prompts shown
 *  above the textarea when the user presses ↑ on the first line. Pure presentation;
 *  navigation is driven by the owning PromptInput via PopoverList's activeIndex.
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
  return (
    <PopoverList
      items={entries}
      activeIndex={activeIndex}
      getKey={(_entry, i) => String(i)}
      onSelect={(entry) => onSelect(entry)}
      onHover={onHover}
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
