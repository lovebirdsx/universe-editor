/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MentionPopover — inline autocomplete shown above the prompt textarea
 *  while the user types `@<query>`. Mirrors SlashCommandPopover: pure
 *  presentation, navigation/acceptance driven by <PromptInput> through
 *  keyboard handlers on the textarea so focus never leaves the input.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { MentionFileEntry } from '../../services/acp/mentionFileSearch.js'
import { PopoverList } from '@universe-editor/workbench-ui'
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
  return (
    <PopoverList
      items={entries}
      activeIndex={activeIndex}
      getKey={(e) => e.uri}
      onSelect={(e) => onSelect(e)}
      onHover={onHover}
      loading={loading ?? false}
      className={styles['promptPopover']}
      data-testid="acp-mention-popover"
      loadingLabel={localize('acp.mention.loading', 'Scanning files…')}
      emptyLabel={localize('acp.mention.empty', 'No matching files')}
      renderItem={(e) => (
        <>
          <span className={styles['slashName']}>{e.name}</span>
          <span className={styles['slashDesc']}>{e.relPath}</span>
        </>
      )}
    />
  )
}
