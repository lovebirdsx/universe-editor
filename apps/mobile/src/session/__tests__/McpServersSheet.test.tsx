import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { strings } from '../../strings.js'
import { McpServersSheet } from '../McpServersSheet.js'

const pool = [
  { name: 'shared', transport: 'stdio' as const, defaultDisabled: false },
  { name: 'docs', transport: 'http' as const, defaultDisabled: true },
  { name: 'db', transport: 'sse' as const, defaultDisabled: false },
]

function makeSettings(
  overrides: Partial<{
    selection: readonly string[] | null
    enabled: readonly string[]
    live: readonly { name: string; status: string; transport?: 'stdio' | 'http' | 'sse' }[]
  }> = {},
) {
  return {
    pool,
    selection: overrides.selection ?? null,
    enabled: overrides.enabled ?? ['shared', 'db'],
    live: overrides.live ?? [],
  }
}

function row(name: string): HTMLElement {
  const found = screen
    .getAllByTestId('mcp-server-row')
    .find((element) => element.getAttribute('data-name') === name)
  if (found === undefined) throw new Error(`missing row ${name}`)
  return found
}

describe('McpServersSheet', () => {
  it('shows the inherited defaults without a reset action', () => {
    render(
      <McpServersSheet
        settings={makeSettings()}
        online
        busy={false}
        onToggle={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(strings.mcpFollowingDefaults)).toBeTruthy()
    expect(screen.queryByTestId('mcp-reset')).toBeNull()
    expect((row('shared').querySelector('input') as HTMLInputElement).checked).toBe(true)
    expect((row('docs').querySelector('input') as HTMLInputElement).checked).toBe(false)
    expect(row('docs').textContent).toContain(strings.mcpDefaultOff)
  })

  it('shows a custom selection and resets it', () => {
    const onReset = vi.fn()
    render(
      <McpServersSheet
        settings={makeSettings({ selection: ['docs'], enabled: ['docs'] })}
        online
        busy={false}
        onToggle={vi.fn()}
        onReset={onReset}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(strings.mcpCustomSelection)).toBeTruthy()
    fireEvent.click(screen.getByTestId('mcp-reset'))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('toggles a row by name', () => {
    const onToggle = vi.fn()
    render(
      <McpServersSheet
        settings={makeSettings()}
        online
        busy={false}
        onToggle={onToggle}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(row('docs').querySelector('input')!)
    expect(onToggle).toHaveBeenCalledWith('docs')
  })

  it('paints live status dots by tone', () => {
    render(
      <McpServersSheet
        settings={makeSettings({
          live: [
            { name: 'shared', status: 'connected', transport: 'stdio' },
            { name: 'docs', status: 'failed', transport: 'http' },
            { name: 'db', status: 'starting', transport: 'sse' },
          ],
        })}
        online
        busy={false}
        onToggle={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(row('shared').querySelector('.mcp-status-dot')?.getAttribute('data-tone')).toBe('ok')
    expect(row('docs').querySelector('.mcp-status-dot')?.getAttribute('data-tone')).toBe('error')
    expect(row('db').querySelector('.mcp-status-dot')?.getAttribute('data-tone')).toBe('pending')
  })

  it('explains an empty pool', () => {
    render(
      <McpServersSheet
        settings={{ pool: [], selection: null, enabled: [], live: [] }}
        online
        busy={false}
        onToggle={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(strings.mcpEmpty)).toBeTruthy()
    expect(screen.queryByTestId('mcp-server-row')).toBeNull()
  })

  it('disables the rows while offline or busy', () => {
    const { unmount } = render(
      <McpServersSheet
        settings={makeSettings()}
        online={false}
        busy={false}
        onToggle={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect((row('shared').querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(strings.pendingOffline)).toBeTruthy()
    unmount()

    render(
      <McpServersSheet
        settings={makeSettings({ selection: ['docs'], enabled: ['docs'] })}
        online
        busy
        onToggle={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect((row('shared').querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('mcp-reset') as HTMLButtonElement).disabled).toBe(true)
  })
})
