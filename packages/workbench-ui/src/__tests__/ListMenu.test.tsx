import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ListMenu, type ListMenuEntry } from '../contextMenu/ListMenu.js'

/** The row the virtual focus points at, read back through the ARIA attribute. */
function activeLabel(menu: HTMLElement): string | null {
  const id = menu.getAttribute('aria-activedescendant')
  return id === null ? null : (menu.ownerDocument.getElementById(id)?.textContent ?? null)
}

const rootMenu = (): HTMLElement => screen.getAllByRole('menu')[0]!

const press = (key: string): void => {
  act(() => {
    fireEvent.keyDown(window, { key })
  })
}

describe('ListMenu', () => {
  afterEach(cleanup)

  function renderMenu(items: readonly ListMenuEntry[], props: { autoFocusFirst?: boolean } = {}) {
    const onClose = vi.fn()
    render(
      <ListMenu
        items={items}
        anchor={{ x: 0, y: 0 }}
        onClose={onClose}
        {...(props.autoFocusFirst === undefined ? {} : { autoFocusFirst: props.autoFocusFirst })}
      />,
    )
    return { onClose }
  }

  it('renders items and separators, and runs a picked item after closing', () => {
    const run = vi.fn()
    const { onClose } = renderMenu([
      { kind: 'item', label: 'First', run },
      { kind: 'separator' },
      { kind: 'item', label: 'Second', run: vi.fn() },
    ])

    expect(screen.getByRole('separator')).toBeDefined()
    fireEvent.click(screen.getByText('First'))

    expect(run).toHaveBeenCalledTimes(1)
    // Closed before running, so a handler opening a dialog isn't racing a menu
    // that is still on screen.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when there are no items', () => {
    renderMenu([])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('reports the close and leaves arrow keys alone when empty', () => {
    const { onClose } = renderMenu([])

    // An empty menu never opens, so the host is told to drop its state right
    // away instead of keeping a null-rendering component mounted.
    expect(onClose).toHaveBeenCalled()

    // Regression: the navigation listener used to stay armed on an empty menu
    // and swallow ArrowUp/ArrowDown at the window capture phase (Left/Right
    // slipped through), leaving the tree underneath dead to vertical keys.
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
    act(() => {
      window.dispatchEvent(down)
    })
    expect(down.defaultPrevented).toBe(false)
  })

  describe('autoFocusFirst', () => {
    it('highlights the first row on open so Enter runs it straight away', () => {
      const run = vi.fn()
      renderMenu([{ kind: 'item', label: 'First', run }], { autoFocusFirst: true })

      expect(activeLabel(rootMenu())).toBe('First')
      press('Enter')
      expect(run).toHaveBeenCalledTimes(1)
    })

    it('leaves nothing highlighted when omitted (mouse-opened menus)', () => {
      renderMenu([{ kind: 'item', label: 'First', run: vi.fn() }])

      expect(rootMenu().getAttribute('aria-activedescendant')).toBeNull()
      expect(document.querySelector('[data-active]')).toBeNull()
    })

    it('skips a leading separator when picking the opening highlight', () => {
      renderMenu([{ kind: 'separator' }, { kind: 'item', label: 'Real', run: vi.fn() }], {
        autoFocusFirst: true,
      })

      expect(activeLabel(rootMenu())).toBe('Real')
    })
  })

  describe('keyboard navigation', () => {
    it('steps across separators and wraps around', () => {
      renderMenu(
        [
          { kind: 'item', label: 'A', run: vi.fn() },
          { kind: 'separator' },
          { kind: 'item', label: 'B', run: vi.fn() },
        ],
        { autoFocusFirst: true },
      )

      const menu = rootMenu()
      expect(activeLabel(menu)).toBe('A')
      press('ArrowDown')
      expect(activeLabel(menu)).toBe('B')
      press('ArrowDown')
      expect(activeLabel(menu)).toBe('A')
      press('ArrowUp')
      expect(activeLabel(menu)).toBe('B')
    })

    it('jumps to the ends with Home and End', () => {
      renderMenu(
        [
          { kind: 'item', label: 'A', run: vi.fn() },
          { kind: 'item', label: 'B', run: vi.fn() },
          { kind: 'item', label: 'C', run: vi.fn() },
        ],
        { autoFocusFirst: true },
      )

      const menu = rootMenu()
      press('End')
      expect(activeLabel(menu)).toBe('C')
      press('Home')
      expect(activeLabel(menu)).toBe('A')
    })

    it('does not act on a composing Enter (IME candidate commit)', () => {
      const run = vi.fn()
      renderMenu([{ kind: 'item', label: 'A', run }], { autoFocusFirst: true })

      act(() => {
        fireEvent.keyDown(window, { key: 'Enter', isComposing: true })
      })
      expect(run).not.toHaveBeenCalled()
    })
  })

  describe('disabled items', () => {
    const items: readonly ListMenuEntry[] = [
      { kind: 'item', label: 'Enabled', run: vi.fn() },
      { kind: 'item', label: 'Dimmed', disabled: true, run: vi.fn() },
      { kind: 'item', label: 'Last', run: vi.fn() },
    ]

    it('marks them aria-disabled', () => {
      renderMenu(items)
      const dimmed = screen.getByText('Dimmed').closest('[role="menuitem"]')
      expect(dimmed?.getAttribute('aria-disabled')).toBe('true')
    })

    it('is skipped by arrow navigation', () => {
      renderMenu(items, { autoFocusFirst: true })

      const menu = rootMenu()
      expect(activeLabel(menu)).toBe('Enabled')
      press('ArrowDown')
      expect(activeLabel(menu)).toBe('Last')
    })

    it('never takes the opening highlight', () => {
      renderMenu([{ kind: 'item', label: 'Dimmed', disabled: true, run: vi.fn() }, ...items], {
        autoFocusFirst: true,
      })
      expect(activeLabel(rootMenu())).toBe('Enabled')
    })

    it('does not run on click', () => {
      const run = vi.fn()
      const { onClose } = renderMenu([{ kind: 'item', label: 'Dimmed', disabled: true, run }])

      fireEvent.click(screen.getByText('Dimmed'))
      expect(run).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  describe('submenus', () => {
    const withSubmenu: readonly ListMenuEntry[] = [
      { kind: 'item', label: 'Plain', run: vi.fn() },
      {
        kind: 'submenu',
        label: 'Go to',
        children: [
          { kind: 'item', label: 'Definition', run: vi.fn() },
          { kind: 'item', label: 'References', run: vi.fn() },
        ],
      },
    ]

    it('mounts children only once the row is opened', () => {
      renderMenu(withSubmenu)
      expect(screen.queryByText('Definition')).toBeNull()

      fireEvent.mouseEnter(screen.getByText('Go to'))
      expect(screen.getByText('Definition')).toBeDefined()
    })

    it('expands with ArrowRight and collapses with ArrowLeft', () => {
      renderMenu(withSubmenu, { autoFocusFirst: true })

      press('ArrowDown')
      expect(activeLabel(rootMenu())).toBe('Go to')

      press('ArrowRight')
      const panel = screen.getByTestId('context-menu-submenu')
      expect(activeLabel(panel)).toBe('Definition')

      press('ArrowLeft')
      expect(screen.queryByTestId('context-menu-submenu')).toBeNull()
      expect(activeLabel(rootMenu())).toBe('Go to')
    })

    it('runs a nested item with Enter', () => {
      const run = vi.fn()
      const { onClose } = renderMenu(
        [
          {
            kind: 'submenu',
            label: 'Go to',
            children: [{ kind: 'item', label: 'Definition', run }],
          },
        ],
        { autoFocusFirst: true },
      )

      press('ArrowRight')
      press('Enter')
      expect(run).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('Escape peels off one level rather than closing the whole menu', () => {
      const { onClose } = renderMenu(withSubmenu, { autoFocusFirst: true })

      press('ArrowDown')
      press('ArrowRight')
      expect(screen.getByTestId('context-menu-submenu')).toBeDefined()

      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' })
      })
      expect(screen.queryByTestId('context-menu-submenu')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()

      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' })
      })
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('memory (last executed)', () => {
    function makeMemory(initial?: Record<string, string>) {
      const map = new Map(Object.entries(initial ?? {}))
      return {
        get: (scope: string, contextTag: string | undefined) =>
          map.get(`${scope}|${contextTag ?? ''}`),
        set: (scope: string, contextTag: string | undefined, itemId: string) => {
          map.set(`${scope}|${contextTag ?? ''}`, itemId)
        },
      }
    }

    function twoItems(): readonly ListMenuEntry[] {
      return [
        { kind: 'item', id: 'a', label: 'First', run: vi.fn() },
        { kind: 'item', id: 'b', label: 'Second', run: vi.fn() },
      ]
    }

    function renderWithMemory(
      items: readonly ListMenuEntry[],
      memory: ReturnType<typeof makeMemory>,
      props: { autoFocusFirst?: boolean; contextTag?: string } = {},
    ) {
      const onClose = vi.fn()
      render(
        <ListMenu
          items={items}
          anchor={{ x: 0, y: 0 }}
          memory={memory}
          memoryKey="test.list"
          onClose={onClose}
          {...(props.autoFocusFirst === undefined ? {} : { autoFocusFirst: props.autoFocusFirst })}
          {...(props.contextTag === undefined ? {} : { contextTag: props.contextTag })}
        />,
      )
      return { onClose }
    }

    it('pre-highlights the remembered row when opened by keyboard', () => {
      const memory = makeMemory({ 'test.list|': 'b' })
      renderWithMemory(twoItems(), memory, { autoFocusFirst: true })

      expect(activeLabel(rootMenu())).toBe('Second')
    })

    it('falls back to the first row when the remembered id is gone', () => {
      const memory = makeMemory({ 'test.list|': 'no.such.id' })
      renderWithMemory(twoItems(), memory, { autoFocusFirst: true })

      expect(activeLabel(rootMenu())).toBe('First')
    })

    it('falls back to the first row when the remembered row turned disabled', () => {
      const memory = makeMemory({ 'test.list|': 'a' })
      renderWithMemory(
        [
          { kind: 'item', id: 'a', label: 'First', disabled: true, run: vi.fn() },
          { kind: 'item', id: 'b', label: 'Second', run: vi.fn() },
        ],
        memory,
        { autoFocusFirst: true },
      )

      expect(activeLabel(rootMenu())).toBe('Second')
    })

    it('leaves mouse-opened menus unhighlighted even when memory has a hit', () => {
      const memory = makeMemory({ 'test.list|': 'b' })
      renderWithMemory(twoItems(), memory)

      expect(rootMenu().getAttribute('aria-activedescendant')).toBeNull()
    })

    it('scopes memory by contextTag', () => {
      const memory = makeMemory({
        'test.list|file': 'b',
        'test.list|directory': 'a',
      })

      const first = renderWithMemory(twoItems(), memory, {
        autoFocusFirst: true,
        contextTag: 'file',
      })
      expect(activeLabel(rootMenu())).toBe('Second')
      expect(first.onClose).not.toHaveBeenCalled()
      cleanup()

      renderWithMemory(twoItems(), memory, { autoFocusFirst: true, contextTag: 'directory' })
      expect(activeLabel(rootMenu())).toBe('First')
    })

    it('records the picked item into memory (double-written under the tag-less bucket)', () => {
      const memory = makeMemory()
      renderWithMemory(twoItems(), memory, { autoFocusFirst: true, contextTag: 'file' })

      fireEvent.click(screen.getByRole('menuitem', { name: 'Second' }))
      expect(memory.get('test.list', 'file')).toBe('b')
      // The tag-less bucket powers the cross-contextTag fallback on next open.
      expect(memory.get('test.list', undefined)).toBe('b')
    })

    it('borrows the memoryKey-level memory when the contextTag bucket is empty', () => {
      const memory = makeMemory({ 'test.list|': 'b' })
      renderWithMemory(twoItems(), memory, { autoFocusFirst: true, contextTag: 'directory' })

      expect(activeLabel(rootMenu())).toBe('Second')
    })

    it('ignores the memoryKey-level memory when the item is absent from this menu', () => {
      const memory = makeMemory({ 'test.list|': 'other' })
      renderWithMemory([{ kind: 'item', id: 'only', label: 'Only', run: vi.fn() }], memory, {
        autoFocusFirst: true,
        contextTag: 'directory',
      })

      expect(activeLabel(rootMenu())).toBe('Only')
    })

    it('stays silent when memory is set without a memoryKey', () => {
      const memory = makeMemory()
      const onClose = vi.fn()
      render(
        <ListMenu
          items={twoItems()}
          anchor={{ x: 0, y: 0 }}
          memory={memory}
          autoFocusFirst
          onClose={onClose}
        />,
      )

      expect(activeLabel(rootMenu())).toBe('First')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Second' }))
      expect(memory.get('test.list', undefined)).toBeUndefined()
    })

    it('restores onto the nested row itself when the remembered id is in a submenu', () => {
      const memory = makeMemory({ 'test.list|': 'nested' })
      renderWithMemory(
        [
          { kind: 'item', id: 'top', label: 'Top', run: vi.fn() },
          {
            kind: 'submenu',
            id: 'more',
            label: 'More',
            children: [{ kind: 'item', id: 'nested', label: 'Nested', run: vi.fn() }],
          },
        ],
        memory,
        { autoFocusFirst: true },
      )

      const submenu = screen.getByTestId('context-menu-submenu')
      expect(activeLabel(submenu)).toBe('Nested')
      expect(screen.getByRole('menuitem', { name: 'More' }).getAttribute('aria-expanded')).toBe(
        'true',
      )
    })

    it('runs the remembered nested item on a bare Enter', () => {
      const run = vi.fn()
      const memory = makeMemory({ 'test.list|': 'nested' })
      renderWithMemory(
        [
          { kind: 'item', id: 'top', label: 'Top', run: vi.fn() },
          {
            kind: 'submenu',
            id: 'more',
            label: 'More',
            children: [{ kind: 'item', id: 'nested', label: 'Nested', run }],
          },
        ],
        memory,
        { autoFocusFirst: true },
      )

      press('Enter')
      expect(run).toHaveBeenCalledTimes(1)
    })
  })
})
