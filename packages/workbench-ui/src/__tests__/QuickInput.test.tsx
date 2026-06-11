/*---------------------------------------------------------------------------------------------
 *  Tests for QuickPickPanel prefix-mode behavior (VSCode-style ">" quick access).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { QuickPickPanel } from '../feedback/quickInput/QuickInputPanel.js'
import type { QuickPickState } from '../feedback/quickInput/quickInputViewModel.js'

// happy-dom has no layout engine so @tanstack/react-virtual renders 0 visible items.
// Mock it so all items are "visible" and existing text assertions continue to work.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: i,
        start: i * opts.estimateSize(i),
        size: opts.estimateSize(i),
        lane: 0,
        end: (i + 1) * opts.estimateSize(i),
      })),
    getTotalSize: () =>
      Array.from({ length: opts.count }, (_, i) => opts.estimateSize(i)).reduce(
        (total, height) => total + height,
        0,
      ),
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
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    expect(input.value).toBe('>')
    expect(input.getAttribute('spellcheck')).toBe('false')
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

  it('reserves an aligned icon column when any item has an icon', () => {
    render(
      <QuickPickPanel
        state={makeState({
          prefix: undefined,
          items: [
            { id: 'open', label: 'Open workspace', iconId: 'check' },
            { id: 'closed', label: 'Closed workspace' },
          ],
        })}
        onClose={() => undefined}
      />,
    )

    const iconSlots = screen.getAllByTestId('quick-input-item-icon-slot')
    expect(iconSlots).toHaveLength(2)
    expect(iconSlots[0]?.getAttribute('data-icon-id')).toBe('check')
    expect(iconSlots[1]?.getAttribute('data-icon-id')).toBe('')
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

  it('word filter matches "Category: Title" label when searching by category name', () => {
    render(
      <QuickPickPanel
        state={makeState({
          items: [
            { id: 'git.commit', label: 'Git: Commit' },
            { id: 'git.push', label: 'Git: Push' },
            { id: 'view.toggle', label: 'View: Toggle Sidebar' },
          ],
          filterMode: 'word',
        })}
        onClose={() => undefined}
      />,
    )
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    fireEvent.change(input, { target: { value: '>git' } })
    expect(screen.getByText('Git: Commit')).toBeTruthy()
    expect(screen.getByText('Git: Push')).toBeTruthy()
    expect(screen.queryByText('View: Toggle Sidebar')).toBeNull()
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

  it('renders separators as group headers and accepts the first selectable item', () => {
    const onAccept = vi.fn()
    render(
      <QuickPickPanel
        state={makeState({
          items: [
            { type: 'separator', id: 'group.src', label: 'a.ts', description: 'src' },
            { id: 'match.a', label: 'const needle = true' },
          ],
          prefix: undefined,
          filterExternally: true,
          onAccept,
        })}
        onClose={() => undefined}
      />,
    )

    expect(screen.getByTestId('quick-input-separator').textContent).toContain('a.ts')
    fireEvent.keyDown(screen.getByTestId('quick-input-field'), { key: 'Enter' })
    expect(onAccept).toHaveBeenCalledWith([{ id: 'match.a', label: 'const needle = true' }], {
      ctrl: false,
      alt: false,
    })
  })

  it('keeps only separators that have matching items during internal filtering', () => {
    render(
      <QuickPickPanel
        state={makeState({
          items: [
            { type: 'separator', id: 'group.a', label: 'a.ts' },
            { id: 'match.a', label: 'alpha' },
            { type: 'separator', id: 'group.b', label: 'b.ts' },
            { id: 'match.b', label: 'beta' },
          ],
          prefix: undefined,
        })}
        onClose={() => undefined}
      />,
    )

    fireEvent.change(screen.getByTestId('quick-input-field'), { target: { value: 'beta' } })

    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('renders label highlight ranges', () => {
    const { container } = render(
      <QuickPickPanel
        state={makeState({
          items: [{ id: 'match', label: 'needle', highlights: { label: [{ start: 1, end: 3 }] } }],
          prefix: undefined,
        })}
        onClose={() => undefined}
      />,
    )

    expect(container.querySelector('mark')?.textContent).toBe('ee')
  })

  it('applies compact presentation to item rows', () => {
    render(
      <QuickPickPanel
        state={makeState({ prefix: undefined, presentation: 'compact' })}
        onClose={() => undefined}
      />,
    )

    expect(screen.getAllByRole('option')[0]?.className).toContain('compactItem')
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

  it('x on the focused item removes it in quick-navigate mode', () => {
    const onItemRemove = vi.fn()
    render(
      <QuickPickPanel
        state={makeState({
          prefix: undefined,
          quickNavigate: { modifier: 'ctrl', initialSelectionIndex: 0 },
          onItemRemove,
        })}
        onClose={() => undefined}
      />,
    )
    const input = screen.getByTestId('quick-input-field')
    fireEvent.keyDown(input, { key: 'x', ctrlKey: true })
    expect(onItemRemove).toHaveBeenCalledWith(items[0])
    expect(screen.queryByText('Format Document')).toBeNull()
    expect(screen.getByText('Go to Line')).toBeTruthy()
  })

  it('x does not remove items outside quick-navigate mode', () => {
    const onItemRemove = vi.fn()
    render(
      <QuickPickPanel
        state={makeState({ prefix: undefined, onItemRemove })}
        onClose={() => undefined}
      />,
    )
    const input = screen.getByTestId('quick-input-field')
    fireEvent.keyDown(input, { key: 'x' })
    expect(onItemRemove).not.toHaveBeenCalled()
    expect(screen.getByText('Format Document')).toBeTruthy()
  })
})

describe('QuickPickPanel active item (live preview)', () => {
  it('reports the first item on mount and the new item on navigation', () => {
    const onActiveChange = vi.fn()
    render(
      <QuickPickPanel
        state={makeState({ prefix: undefined, onActiveChange })}
        onClose={() => undefined}
      />,
    )
    expect(onActiveChange).toHaveBeenLastCalledWith(items[0])

    fireEvent.keyDown(screen.getByTestId('quick-input-field'), { key: 'ArrowDown' })
    expect(onActiveChange).toHaveBeenLastCalledWith(items[1])
  })

  it('does not re-fire while the focused item id stays the same', () => {
    const onActiveChange = vi.fn()
    render(
      <QuickPickPanel
        state={makeState({ prefix: undefined, onActiveChange })}
        onClose={() => undefined}
      />,
    )
    onActiveChange.mockClear()
    // Typing a query that keeps the first item focused must not re-report it.
    fireEvent.change(screen.getByTestId('quick-input-field'), { target: { value: 'Format' } })
    expect(onActiveChange).not.toHaveBeenCalled()
  })

  it('reports undefined when the list becomes empty', () => {
    const onActiveChange = vi.fn()
    render(
      <QuickPickPanel
        state={makeState({ prefix: undefined, onActiveChange })}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByTestId('quick-input-field'), { target: { value: 'zzzznomatch' } })
    expect(onActiveChange).toHaveBeenLastCalledWith(undefined)
  })
})
