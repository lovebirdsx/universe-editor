/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ContextPopover — inline autocomplete shown above the prompt textarea while
 *  the user types `#<query>`. Groups four context sources (workspace symbols /
 *  local Git changes / current selection & open editors / user docs) into one
 *  flat PopoverList, tagging each group's first row with a header label.
 *  Pure presentation: navigation/acceptance are driven by <PromptInput> through
 *  keyboard handlers on the textarea, mirroring MentionPopover/SlashCommandPopover.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { PopoverList } from '@universe-editor/workbench-ui'
import type { ContextSuggestionItem } from '../../services/acp/contextSuggestions.js'
import { formatSelectionLabel, type SelectionContext } from '../../services/acp/promptContext.js'
import styles from './agents.module.css'

export type ContextPopoverEntry =
  | { readonly kind: 'suggestion'; readonly item: ContextSuggestionItem }
  | { readonly kind: 'selection'; readonly selection: SelectionContext }

export interface ContextPopoverGroup {
  readonly label: string
  readonly entries: readonly ContextPopoverEntry[]
}

export interface ContextPopoverRow {
  readonly entry: ContextPopoverEntry
  /** Set only on a group's first row — renderItem shows it as a header above the row. */
  readonly groupLabel: string | undefined
}

/** Flatten groups into PopoverList rows (PopoverList has no native grouping — see plan §5.1). */
export function buildContextPopoverRows(
  groups: readonly ContextPopoverGroup[],
): readonly ContextPopoverRow[] {
  const rows: ContextPopoverRow[] = []
  for (const group of groups) {
    group.entries.forEach((entry, i) => {
      rows.push({ entry, groupLabel: i === 0 ? group.label : undefined })
    })
  }
  return rows
}

function entryKey(entry: ContextPopoverEntry): string {
  if (entry.kind !== 'suggestion') {
    return `selection:${entry.selection.uri}:${entry.selection.startLine}-${entry.selection.endLine}`
  }
  const { item } = entry
  // symbol/openEditor items can share the same file uri (multiple symbols per
  // file, or the same file counted once — but symbols still need a per-symbol
  // key), so fold in position + label to keep keys unique within a file.
  return item.kind === 'symbol'
    ? `suggestion:symbol:${item.uri}:${item.meta?.line ?? ''}:${item.meta?.column ?? ''}:${item.label}`
    : `suggestion:${item.kind}:${item.uri}`
}

function entryLabel(entry: ContextPopoverEntry): string {
  return entry.kind === 'suggestion' ? entry.item.label : formatSelectionLabel(entry.selection)
}

function entryDescription(entry: ContextPopoverEntry): string {
  return entry.kind === 'suggestion'
    ? entry.item.description
    : localize('acp.contextRef.selection.description', 'Current selection')
}

export interface ContextPopoverProps {
  readonly rows: readonly ContextPopoverRow[]
  readonly activeIndex: number
  readonly loading?: boolean
  readonly onSelect: (entry: ContextPopoverEntry) => void
  readonly onHover: (index: number) => void
}

export function ContextPopover({
  rows,
  activeIndex,
  loading,
  onSelect,
  onHover,
}: ContextPopoverProps) {
  return (
    <PopoverList
      items={rows}
      activeIndex={activeIndex}
      getKey={(r) => entryKey(r.entry)}
      onSelect={(r) => onSelect(r.entry)}
      onHover={onHover}
      loading={loading ?? false}
      className={styles['promptPopover']}
      data-testid="acp-context-popover"
      loadingLabel={localize('acp.contextRef.loading', 'Loading context…')}
      emptyLabel={localize('acp.contextRef.empty', 'No matching context')}
      renderItem={(row) => (
        <div className={styles['contextItemBody']}>
          {row.groupLabel !== undefined ? (
            <div className={styles['contextGroupLabel']}>{row.groupLabel}</div>
          ) : null}
          <div className={styles['contextItemRow']}>
            <span className={styles['slashName']}>{entryLabel(row.entry)}</span>
            <span className={styles['slashDesc']}>{entryDescription(row.entry)}</span>
          </div>
        </div>
      )}
    />
  )
}
