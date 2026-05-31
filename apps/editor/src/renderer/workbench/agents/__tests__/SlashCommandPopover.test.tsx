/*---------------------------------------------------------------------------------------------
 *  Tests for the slash-command popover: pure filtering helper + render
 *  behaviour. Keyboard wiring is covered via PromptInput integration tests
 *  in PromptInput.test.tsx (kept separate because we need the session/service
 *  scaffolding there).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { SlashCommandPopover, filterCommands } from '../SlashCommandPopover.js'

afterEach(() => cleanup())

const COMMANDS: readonly AvailableCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/diff', description: 'Show diff', input: { hint: 'path' } },
  { name: '/clear', description: 'Clear the session' },
  { name: '/model', description: 'Switch model' },
]

describe('filterCommands', () => {
  it('returns the full list for an empty query', () => {
    expect(filterCommands(COMMANDS, '')).toHaveLength(4)
  })

  it('matches against name without leading slash', () => {
    const r = filterCommands(COMMANDS, 'di')
    expect(r.map((c) => c.name)).toEqual(['/diff'])
  })

  it('matches against name with leading slash typed in', () => {
    // The user may type the leading `/` themselves; it's stripped before
    // matching. `help` is selective enough that the subsequence matcher
    // singles out `/help` without catching any description.
    const r = filterCommands(COMMANDS, '/help')
    expect(r.map((c) => c.name)).toEqual(['/help'])
  })

  it('matches against description', () => {
    const r = filterCommands(COMMANDS, 'session')
    expect(r.map((c) => c.name)).toEqual(['/clear'])
  })

  it('returns empty for no matches', () => {
    expect(filterCommands(COMMANDS, 'zzzzz')).toEqual([])
  })

  it('ranks an exact name match first, above description-only matches', () => {
    const cmds: readonly AvailableCommand[] = [
      { name: '/update-config', description: 'compose a project config' },
      { name: '/compact', description: 'Summarize the conversation' },
    ]
    // `/update-config` only matches `compact` via a loose description
    // subsequence; the exact name match must still win.
    const r = filterCommands(cmds, 'compact')
    expect(r[0]?.name).toBe('/compact')
  })
})

describe('SlashCommandPopover render', () => {
  it('renders each command with its description and optional hint', () => {
    render(
      <SlashCommandPopover
        commands={COMMANDS}
        activeIndex={0}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    )
    const items = screen.getAllByRole('option')
    expect(items).toHaveLength(4)
    // The /diff row should show the <path> hint placeholder.
    expect(items[1]?.textContent).toContain('<path>')
    // The active row has aria-selected=true.
    expect(items[0]?.getAttribute('aria-selected')).toBe('true')
    expect(items[1]?.getAttribute('aria-selected')).toBe('false')
  })

  it('shows an empty placeholder when there are no commands', () => {
    render(
      <SlashCommandPopover commands={[]} activeIndex={0} onSelect={() => {}} onHover={() => {}} />,
    )
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/No matching commands/i)).toBeTruthy()
  })

  it('fires onSelect when an item is clicked (via mousedown so focus stays)', () => {
    const onSelect = vi.fn()
    render(
      <SlashCommandPopover
        commands={COMMANDS}
        activeIndex={0}
        onSelect={onSelect}
        onHover={() => {}}
      />,
    )
    const items = screen.getAllByRole('option')
    fireEvent.mouseDown(items[2]!)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0]?.[0]).toEqual(COMMANDS[2])
  })

  it('fires onHover when the cursor enters a row', () => {
    const onHover = vi.fn()
    render(
      <SlashCommandPopover
        commands={COMMANDS}
        activeIndex={0}
        onSelect={() => {}}
        onHover={onHover}
      />,
    )
    const items = screen.getAllByRole('option')
    fireEvent.mouseEnter(items[1]!)
    expect(onHover).toHaveBeenCalledWith(1)
  })
})
