/*---------------------------------------------------------------------------------------------
 *  Tests for QuickPickPanel prefix-mode behavior (VSCode-style ">" quick access).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { QuickPickPanel } from '../QuickInput.js'
import type { QuickPickState } from '../../../services/quickInput/QuickInputService.js'

// happy-dom has no layout engine so @tanstack/react-virtual renders 0 visible items.
// Mock it so all items are "visible" and existing text assertions continue to work.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: i,
        start: i * opts.estimateSize(),
        size: opts.estimateSize(),
        lane: 0,
        end: (i + 1) * opts.estimateSize(),
      })),
    getTotalSize: () => opts.count * opts.estimateSize(),
    scrollToIndex: vi.fn(),
  }),
}))

afterEach(() => cleanup())

const items = [
  { id: 'cmd.format', label: 'Format Document' },
  { id: 'cmd.line', label: 'Go to Line' },
]

const focusGroupCommands = [
  { id: 'workbench.action.focusNextGroup', label: 'Focus Next Group', description: 'View' },
  { id: 'workbench.action.focusFirstGroup', label: 'Focus First Group', description: 'View' },
  { id: 'workbench.action.focusLastGroup', label: 'Focus Last Group', description: 'View' },
  { id: 'workbench.action.focusPreviousGroup', label: 'Focus Previous Group', description: 'View' },
  {
    id: 'workbench.action.focusRightGroup',
    label: 'Focus Right Editor Group',
    description: 'View',
  },
  { id: 'workbench.action.focusLeftGroup', label: 'Focus Left Editor Group', description: 'View' },
]

function makeState(extra: Partial<QuickPickState> = {}): QuickPickState {
  return { type: 'pick', items, prefix: '>', onAccept: vi.fn(), onHide: vi.fn(), ...extra }
}

describe('QuickPickPanel prefix mode', () => {
  it('prefills the input with the prefix on open', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    expect((screen.getByTestId('quick-input-field') as HTMLInputElement).value).toBe('>')
    // both items visible (empty filter text after stripping prefix)
    expect(screen.getByText('Format Document')).toBeTruthy()
    expect(screen.getByText('Go to Line')).toBeTruthy()
  })

  it('filters items by the text after the prefix', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    fireEvent.change(input, { target: { value: '>fmt' } })
    expect(screen.getByText('Format Document')).toBeTruthy()
    expect(screen.queryByText('Go to Line')).toBeNull()
  })

  it('shows a hint and suppresses the list when the prefix is wiped', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByText('Format Document')).toBeNull()
    expect(screen.queryByText('Go to Line')).toBeNull()
    expect(screen.getByText(/Type '>' followed by a command name/)).toBeTruthy()
  })

  it('behaves like a plain picker (no prefix) when state.prefix is undefined', () => {
    render(<QuickPickPanel state={makeState({ prefix: undefined })} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'line' } })
    expect(screen.queryByText('Format Document')).toBeNull()
    expect(screen.getByText('Go to Line')).toBeTruthy()
  })

  it('renders keybinding hint when item has keybinding field', () => {
    const state = makeState({
      items: [{ id: 'cmd.format', label: 'Format Document', keybinding: 'Ctrl+Shift+P' }],
    })
    render(<QuickPickPanel state={state} onClose={() => undefined} />)
    expect(screen.getByText('Ctrl+Shift+P')).toBeTruthy()
  })

  it('does not render keybinding when item has no keybinding field', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    // default items have no keybinding; no unexpected keybinding text should appear
    expect(screen.queryByText('Ctrl+')).toBeNull()
  })

  it('uses word filtering for command labels so focus ri selects Focus Right first', () => {
    render(
      <QuickPickPanel
        state={makeState({ items: focusGroupCommands, filterMode: 'word' })}
        onClose={() => undefined}
      />,
    )
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    fireEvent.change(input, { target: { value: '>focus ri' } })

    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toHaveLength(1)
    expect(options[0]).toContain('Focus Right Editor Group')
  })

  it('does not match description or detail unless enabled', () => {
    render(
      <QuickPickPanel
        state={makeState({
          items: [
            {
              id: 'alpha',
              label: 'Alpha',
              description: 'description-hit',
              detail: 'detail-hit',
            },
          ],
          prefix: undefined,
        })}
        onClose={() => undefined}
      />,
    )
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'description-hit' } })
    expect(screen.queryByText('Alpha')).toBeNull()

    cleanup()
    render(
      <QuickPickPanel
        state={makeState({
          items: [
            {
              id: 'alpha',
              label: 'Alpha',
              description: 'description-hit',
              detail: 'detail-hit',
            },
          ],
          prefix: undefined,
          matchOnDescription: true,
        })}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByTestId('quick-input-field'), {
      target: { value: 'description-hit' },
    })
    expect(screen.getByText('Alpha')).toBeTruthy()

    cleanup()
    render(
      <QuickPickPanel
        state={makeState({
          items: [
            {
              id: 'alpha',
              label: 'Alpha',
              description: 'description-hit',
              detail: 'detail-hit',
            },
          ],
          prefix: undefined,
          matchOnDetail: true,
        })}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByTestId('quick-input-field'), {
      target: { value: 'detail-hit' },
    })
    expect(screen.getByText('Alpha')).toBeTruthy()
  })
})

describe('QuickPickPanel keyboard', () => {
  it('Enter selects the focused item and invokes onAccept + onClose', () => {
    const onAccept = vi.fn()
    const onClose = vi.fn()
    render(<QuickPickPanel state={makeState({ onAccept })} onClose={onClose} />)
    const input = screen.getByTestId('quick-input-field')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAccept).toHaveBeenCalledWith([items[0]], { ctrl: false, alt: false })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Enter calls preventDefault to prevent the key event from leaking to the editor', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field')
    const event = createEvent.keyDown(input, { key: 'Enter' })
    fireEvent(input, event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('Enter with no matching items does nothing', () => {
    const onAccept = vi.fn()
    const onClose = vi.fn()
    render(<QuickPickPanel state={makeState({ onAccept, items: [] })} onClose={onClose} />)
    const input = screen.getByTestId('quick-input-field')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAccept).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ArrowDown moves focus to next item and Enter accepts it', () => {
    const onAccept = vi.fn()
    render(<QuickPickPanel state={makeState({ onAccept })} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAccept).toHaveBeenCalledWith([items[1]], { ctrl: false, alt: false })
  })

  it('Ctrl+N moves focus to next item and Enter accepts it', () => {
    const onAccept = vi.fn()
    render(<QuickPickPanel state={makeState({ onAccept })} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field')
    const event = createEvent.keyDown(input, { key: 'n', ctrlKey: true })

    fireEvent(input, event)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(event.defaultPrevented).toBe(true)
    expect(onAccept).toHaveBeenCalledWith([items[1]], { ctrl: false, alt: false })
  })

  it('Ctrl+P moves focus to previous item and wraps', () => {
    const onAccept = vi.fn()
    render(<QuickPickPanel state={makeState({ onAccept })} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field')
    const event = createEvent.keyDown(input, { key: 'p', ctrlKey: true })

    fireEvent(input, event)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(event.defaultPrevented).toBe(true)
    expect(onAccept).toHaveBeenCalledWith([items[1]], { ctrl: false, alt: false })
  })

  it('Ctrl+Enter reports ctrl modifier to onAccept', () => {
    const onAccept = vi.fn()
    render(<QuickPickPanel state={makeState({ onAccept })} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field')
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(onAccept).toHaveBeenCalledWith([items[0]], { ctrl: true, alt: false })
  })
})

describe('QuickPickPanel item removal', () => {
  it('Delete on the focused item invokes onItemRemove and removes it from the list', () => {
    const onItemRemove = vi.fn()
    const onAccept = vi.fn()
    render(
      <QuickPickPanel state={makeState({ onItemRemove, onAccept })} onClose={() => undefined} />,
    )
    const input = screen.getByTestId('quick-input-field')
    expect(screen.getByText('Format Document')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Delete' })
    expect(onItemRemove).toHaveBeenCalledWith(items[0])
    expect(screen.queryByText('Format Document')).toBeNull()
    expect(screen.getByText('Go to Line')).toBeTruthy()
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('Delete is a no-op when onItemRemove is not provided', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field')
    fireEvent.keyDown(input, { key: 'Delete' })
    expect(screen.getByText('Format Document')).toBeTruthy()
  })

  it('renders a remove button per item only when onItemRemove is set', () => {
    const { rerender } = render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    expect(screen.queryAllByTestId('quick-input-item-remove')).toHaveLength(0)
    rerender(
      <QuickPickPanel state={makeState({ onItemRemove: vi.fn() })} onClose={() => undefined} />,
    )
    expect(screen.getAllByTestId('quick-input-item-remove')).toHaveLength(items.length)
  })

  it('clicking the remove button removes the item without accepting', () => {
    const onItemRemove = vi.fn()
    const onAccept = vi.fn()
    const onClose = vi.fn()
    render(<QuickPickPanel state={makeState({ onItemRemove, onAccept })} onClose={onClose} />)
    const removeButtons = screen.getAllByTestId('quick-input-item-remove')
    fireEvent.click(removeButtons[0]!)
    expect(onItemRemove).toHaveBeenCalledWith(items[0])
    expect(onAccept).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('Format Document')).toBeNull()
  })
})
