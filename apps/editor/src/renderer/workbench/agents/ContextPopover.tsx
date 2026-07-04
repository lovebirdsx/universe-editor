/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ContextPopover — inline autocomplete shown above the prompt textarea while
 *  the user types `#<query>`. A single flat list (no group headers) merging four
 *  context sources (workspace symbols / local Git changes / current selection &
 *  open editors / user docs), each row rendered as `[icon] name … source`, with
 *  the source right-aligned and truncated — mirroring VSCode Copilot's `#` picker.
 *  Pure presentation: navigation/acceptance are driven by <PromptInput> through
 *  keyboard handlers on the textarea, mirroring MentionPopover/SlashCommandPopover.
 *--------------------------------------------------------------------------------------------*/

import { localize, URI } from '@universe-editor/platform'
import { PopoverList } from '@universe-editor/workbench-ui'
import type { ContextSuggestionItem } from '../../services/acp/contextSuggestions.js'
import { formatSelectionLabel, type SelectionContext } from '../../services/acp/promptContext.js'
import { resourceIconId } from '../../services/quickInput/quickPickResourceIcon.js'
import { renderContextIcon } from './contextIcon.js'
import styles from './agents.module.css'

export type ContextPopoverEntry =
  | { readonly kind: 'suggestion'; readonly item: ContextSuggestionItem }
  | { readonly kind: 'selection'; readonly selection: SelectionContext }

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

function entrySource(entry: ContextPopoverEntry): string {
  return entry.kind === 'suggestion'
    ? entry.item.description
    : localize('acp.contextRef.selection.description', 'Current selection')
}

function entryIconId(entry: ContextPopoverEntry): string {
  return entry.kind === 'suggestion'
    ? entry.item.iconId
    : resourceIconId(URI.parse(entry.selection.uri))
}

export interface ContextPopoverProps {
  readonly entries: readonly ContextPopoverEntry[]
  readonly activeIndex: number
  readonly loading?: boolean
  readonly onSelect: (entry: ContextPopoverEntry) => void
  readonly onHover: (index: number) => void
}

const ICON_SIZE = 14

export function ContextPopover({
  entries,
  activeIndex,
  loading,
  onSelect,
  onHover,
}: ContextPopoverProps) {
  return (
    <PopoverList
      items={entries}
      activeIndex={activeIndex}
      getKey={(e) => entryKey(e)}
      onSelect={(e) => onSelect(e)}
      onHover={onHover}
      loading={loading ?? false}
      className={styles['promptPopover']}
      data-testid="acp-context-popover"
      loadingLabel={localize('acp.contextRef.loading', 'Loading context…')}
      emptyLabel={localize('acp.contextRef.empty', 'No matching context')}
      renderItem={(entry) => (
        <>
          <span className={styles['contextIcon']}>
            {renderContextIcon(entryIconId(entry), ICON_SIZE)}
          </span>
          <span className={styles['contextName']}>{entryLabel(entry)}</span>
          <span className={styles['contextSource']}>{entrySource(entry)}</span>
        </>
      )}
    />
  )
}
