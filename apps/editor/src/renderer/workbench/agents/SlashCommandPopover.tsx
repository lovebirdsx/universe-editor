/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SlashCommandPopover — inline autocomplete shown above the prompt textarea
 *  when the user types `/` at the start. Pure presentation: navigation and
 *  acceptance are driven by the owning <PromptInput> through keyboard handlers
 *  on the textarea itself, so focus never leaves the input.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { PopoverList } from '@universe-editor/workbench-ui'
import { fuzzyMatchField, scoreFuzzyMatch } from '@universe-editor/workbench-ui'
import styles from './agents.module.css'

export interface SlashCommandPopoverProps {
  readonly commands: readonly AvailableCommand[]
  readonly activeIndex: number
  readonly onSelect: (cmd: AvailableCommand) => void
  readonly onHover: (index: number) => void
}

/**
 * Build the visible suggestion list. The caller passes the raw `query` (text
 * after the leading `/`). We rank by relevance with the same subsequence
 * matcher Go to File uses: a name match (exact/prefix > substring >
 * subsequence) always ranks above a description-only match, and ties keep the
 * order the agent advertised (mature agents put common commands first).
 */
export function filterCommands(
  commands: readonly AvailableCommand[],
  query: string,
): readonly AvailableCommand[] {
  if (!query) return commands
  // Allow matching with or without a leading `/`.
  const q = query.replace(/^\//, '')
  const scored = commands
    .map((command, index) => ({ command, index, score: scoreCommand(command, q) }))
    .filter((s) => s.score >= 0)
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((s) => s.command)
}

function scoreCommand(command: AvailableCommand, query: string): number {
  const nameScore = scoreFuzzyMatch(command.name.replace(/^\//, ''), query)
  // Name matches outrank any description-only match by a wide margin.
  if (nameScore >= 0) return 10_000 + nameScore
  return fuzzyMatchField(command.description, query) ? 0 : -1
}

export function SlashCommandPopover({
  commands,
  activeIndex,
  onSelect,
  onHover,
}: SlashCommandPopoverProps) {
  return (
    <PopoverList
      items={commands}
      activeIndex={activeIndex}
      getKey={(c) => c.name}
      onSelect={(c) => onSelect(c)}
      onHover={onHover}
      className={styles['promptPopover']}
      data-testid="acp-slash-popover"
      emptyLabel={localize('acp.slash.empty', 'No matching commands')}
      renderItem={(c) => (
        <>
          <span className={styles['slashName']}>
            {c.name.startsWith('/') ? c.name : `/${c.name}`}
          </span>
          {c.input ? <span className={styles['slashHint']}>{`<${c.input.hint}>`}</span> : null}
          <span className={styles['slashDesc']}>{c.description}</span>
        </>
      )}
    />
  )
}
