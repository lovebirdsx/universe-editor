/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SlashCommandPopover — inline autocomplete shown above the prompt textarea
 *  when the user types `/` at the start. Pure presentation: navigation and
 *  acceptance are driven by the owning <PromptInput> through keyboard handlers
 *  on the textarea itself, so focus never leaves the input.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { localize } from '@universe-editor/platform'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import styles from './agents.module.css'

export interface SlashCommandPopoverProps {
  readonly commands: readonly AvailableCommand[]
  readonly activeIndex: number
  readonly onSelect: (cmd: AvailableCommand) => void
  readonly onHover: (index: number) => void
}

/**
 * Build the visible suggestion list. The caller passes the raw `query` (text
 * after the leading `/`), and we fuzzy-prefix-match each command's name and
 * description. The returned list preserves the order the agent advertised
 * (mature agents tend to put the common commands first).
 */
export function filterCommands(
  commands: readonly AvailableCommand[],
  query: string,
): readonly AvailableCommand[] {
  if (!query) return commands
  const q = query.toLowerCase()
  return commands.filter((c) => {
    const name = c.name.toLowerCase()
    // Allow matching with or without a leading `/`.
    return (
      name.includes(q) ||
      name.replace(/^\//, '').startsWith(q) ||
      c.description.toLowerCase().includes(q)
    )
  })
}

export function SlashCommandPopover({
  commands,
  activeIndex,
  onSelect,
  onHover,
}: SlashCommandPopoverProps) {
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the active row in view when the user navigates with arrow keys.
  useEffect(() => {
    const root = listRef.current
    if (!root) return
    const el = root.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (commands.length === 0) {
    return (
      <div className={styles['slashPopover']} role="listbox" data-testid="acp-slash-popover">
        <div className={styles['slashEmpty']}>
          {localize('acp.slash.empty', 'No matching commands')}
        </div>
      </div>
    )
  }

  return (
    <div
      className={styles['slashPopover']}
      role="listbox"
      ref={listRef}
      data-testid="acp-slash-popover"
    >
      {commands.map((c, i) => (
        <div
          key={c.name}
          role="option"
          aria-selected={i === activeIndex}
          data-active={i === activeIndex}
          className={styles['slashItem']}
          onMouseDown={(e) => {
            // Prevent the textarea from losing focus before our click lands.
            e.preventDefault()
            onSelect(c)
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className={styles['slashName']}>
            {c.name.startsWith('/') ? c.name : `/${c.name}`}
          </span>
          {c.input ? <span className={styles['slashHint']}>{`<${c.input.hint}>`}</span> : null}
          <span className={styles['slashDesc']}>{c.description}</span>
        </div>
      ))}
    </div>
  )
}
