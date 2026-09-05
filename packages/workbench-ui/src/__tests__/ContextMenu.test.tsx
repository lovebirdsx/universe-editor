import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandsRegistry,
  MenuRegistry,
  type ICommandService,
  type IContextKeyService,
  type MenuId,
} from '@universe-editor/platform'
import { ContextMenu } from '../contextMenu/ContextMenu.js'

/** `MenuId` is a const enum of well-known ids; tests use ad-hoc ones. */
const asMenuId = (id: string): MenuId => id as unknown as MenuId

function makeCommandService(executed: unknown[][]): ICommandService {
  return {
    executeCommand: async (...args: unknown[]) => {
      executed.push(args)
    },
  } as unknown as ICommandService
}

/** Matches entries whose `when` key is listed in `truthy`. */
function makeContextKeyService(truthy: readonly string[]): IContextKeyService {
  return {
    contextMatchesRules: (expr: { keys?: () => string[] } | undefined) => {
      if (!expr) return true
      const keys = expr.keys?.() ?? []
      return keys.every((k) => truthy.includes(k))
    },
  } as unknown as IContextKeyService
}

/** The row the virtual focus points at, read back through the ARIA attribute. */
function activeLabel(menu: HTMLElement): string | null {
  const id = menu.getAttribute('aria-activedescendant')
  return id === null ? null : (menu.ownerDocument.getElementById(id)?.textContent ?? null)
}

describe('ContextMenu submenus', () => {
  const disposables: { dispose(): void }[] = []

  afterEach(() => {
    cleanup()
    while (disposables.length) disposables.pop()?.dispose()
  })

  function track<T extends { dispose(): void }>(d: T): T {
    disposables.push(d)
    return d
  }

  it('renders a submenu row and reveals its children on hover', () => {
    const root = asMenuId('test.submenu.root1')
    const sub = asMenuId('test.submenu.child1')
    track(MenuRegistry.addMenuItem(root, { command: 'top.cmd', title: 'Top', group: '1_a' }))
    track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More', group: '2_b' }))
    track(MenuRegistry.addMenuItem(sub, { command: 'nested.cmd', title: 'Nested' }))

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Top')).toBeDefined()
    const submenuRow = screen.getByText('More')
    // Children are not mounted until the row is hovered.
    expect(screen.queryByText('Nested')).toBeNull()

    fireEvent.mouseEnter(submenuRow)
    expect(screen.getByText('Nested')).toBeDefined()
  })

  it('executes a nested command and closes the menu', () => {
    const root = asMenuId('test.submenu.root2')
    const sub = asMenuId('test.submenu.child2')
    track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
    track(MenuRegistry.addMenuItem(sub, { command: 'nested.run', title: 'Run It' }))

    const executed: unknown[][] = []
    const onClose = vi.fn()
    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        args={[{ resource: '/ws/a.ts' }]}
        commandService={makeCommandService(executed)}
        onClose={onClose}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('More'))
    fireEvent.click(screen.getByText('Run It'))

    expect(executed).toEqual([['nested.run', { resource: '/ws/a.ts' }]])
    expect(onClose).toHaveBeenCalled()
  })

  it('drops a submenu whose children are all filtered out', () => {
    const root = asMenuId('test.submenu.root3')
    const sub = asMenuId('test.submenu.child3')
    track(MenuRegistry.addMenuItem(root, { command: 'stay.cmd', title: 'Stay' }))
    track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'Empty' }))
    track(MenuRegistry.addMenuItem(sub, { command: 'hidden.cmd', title: 'Hidden', when: 'nope' }))

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        contextKeyService={makeContextKeyService([])}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Stay')).toBeDefined()
    expect(screen.queryByText('Empty')).toBeNull()
  })

  it('drops a submenu with no children at all', () => {
    const root = asMenuId('test.submenu.root4')
    track(MenuRegistry.addMenuItem(root, { command: 'stay.cmd', title: 'Stay' }))
    track(
      MenuRegistry.addSubmenuItem(root, {
        submenu: asMenuId('test.submenu.nothing'),
        title: 'Nothing',
      }),
    )

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByText('Nothing')).toBeNull()
  })

  it('applies when-clauses to nested items', () => {
    const root = asMenuId('test.submenu.root5')
    const sub = asMenuId('test.submenu.child5')
    track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
    track(MenuRegistry.addMenuItem(sub, { command: 'shown.cmd', title: 'Shown', when: 'yes' }))
    track(MenuRegistry.addMenuItem(sub, { command: 'gone.cmd', title: 'Gone', when: 'no' }))

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        contextKeyService={makeContextKeyService(['yes'])}
        onClose={vi.fn()}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('More'))
    expect(screen.getByText('Shown')).toBeDefined()
    expect(screen.queryByText('Gone')).toBeNull()
  })

  it('survives a submenu that contributes into itself', () => {
    const root = asMenuId('test.submenu.cycle')
    track(MenuRegistry.addSubmenuItem(root, { submenu: root, title: 'Loop' }))
    track(MenuRegistry.addMenuItem(root, { command: 'plain.cmd', title: 'Plain' }))

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        onClose={vi.fn()}
      />,
    )

    // The self-referencing row is dropped; the real item still renders.
    expect(screen.getByText('Plain')).toBeDefined()
    expect(screen.queryByText('Loop')).toBeNull()
  })

  it('falls back to command metadata for a nested row label', () => {
    const root = asMenuId('test.submenu.root6')
    const sub = asMenuId('test.submenu.child6')
    track(
      CommandsRegistry.registerCommand({
        id: 'described.cmd',
        handler: () => {},
        metadata: { description: 'Described Command' },
      }),
    )
    track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
    track(MenuRegistry.addMenuItem(sub, { command: 'described.cmd' }))

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        onClose={vi.fn()}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('More'))
    expect(screen.getByText('Described Command')).toBeDefined()
  })

  it('keeps the top-level group filter off nested items', () => {
    const root = asMenuId('test.submenu.root7')
    const sub = asMenuId('test.submenu.child7')
    track(MenuRegistry.addMenuItem(root, { command: 'nav.cmd', title: 'Nav', group: 'navigation' }))
    track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More', group: '1_x' }))
    // A nested item in the filtered-out group must still show: the filter targets
    // the top-level toolbar split, not submenu contents.
    track(
      MenuRegistry.addMenuItem(sub, { command: 'deep.cmd', title: 'Deep', group: 'navigation' }),
    )

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        groupFilter={(g) => g !== 'navigation'}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByText('Nav')).toBeNull()
    fireEvent.mouseEnter(screen.getByText('More'))
    expect(screen.getByText('Deep')).toBeDefined()
  })

  it('expands a third level, deeper than the panel that hosts it', () => {
    const root = asMenuId('test.submenu.deep.root')
    const mid = asMenuId('test.submenu.deep.mid')
    const leaf = asMenuId('test.submenu.deep.leaf')
    track(MenuRegistry.addSubmenuItem(root, { submenu: mid, title: 'Level2' }))
    track(MenuRegistry.addSubmenuItem(mid, { submenu: leaf, title: 'Level3' }))
    track(MenuRegistry.addMenuItem(leaf, { command: 'deepest.cmd', title: 'Deepest' }))

    const executed: unknown[][] = []
    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService(executed)}
        onClose={vi.fn()}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('Level2'))
    expect(screen.queryByText('Deepest')).toBeNull()

    // The nested submenu row used to be a dead end: no hover handler, no panel.
    fireEvent.mouseEnter(screen.getByText('Level3'))
    fireEvent.click(screen.getByText('Deepest'))
    expect(executed).toEqual([['deepest.cmd']])
  })

  it('positions a submenu panel without crashing on all-zero rects', () => {
    const root = asMenuId('test.submenu.rects.root')
    const sub = asMenuId('test.submenu.rects.child')
    track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
    track(MenuRegistry.addMenuItem(sub, { command: 'nested.cmd', title: 'Nested' }))

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        onClose={vi.fn()}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('More'))
    const panel = screen.getByTestId('context-menu-submenu')
    // Measured, so it is no longer parked behind `visibility: hidden`.
    expect(panel.style.visibility).toBe('')
    expect(panel.style.top).toBe('0px')
    expect(panel.style.left).toBe('0px')
  })

  it('caps the panel height to the viewport so a tall submenu scrolls', () => {
    const root = asMenuId('test.submenu.cap.root')
    const sub = asMenuId('test.submenu.cap.child')
    track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
    track(MenuRegistry.addMenuItem(sub, { command: 'nested.cmd', title: 'Nested' }))

    render(
      <ContextMenu
        menuId={root}
        anchor={{ x: 0, y: 0 }}
        commandService={makeCommandService([])}
        onClose={vi.fn()}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('More'))
    const panel = screen.getByTestId('context-menu-submenu')
    // `.submenu` is `position: fixed`, so no ancestor's maxHeight constrains it —
    // without this cap a submenu taller than the window spills off the bottom.
    expect(panel.style.maxHeight).toBe(`${window.innerHeight - 16}px`)
  })

  describe('close grace period', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    function renderTwoLevels() {
      const root = asMenuId(`test.submenu.grace.${Math.random().toString(36).slice(2)}`)
      const sub = asMenuId(`${root}.child`)
      track(MenuRegistry.addMenuItem(root, { command: 'plain.cmd', title: 'Plain' }))
      track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
      track(MenuRegistry.addMenuItem(sub, { command: 'nested.cmd', title: 'Nested' }))
      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          onClose={vi.fn()}
        />,
      )
      fireEvent.mouseEnter(screen.getByText('More'))
      expect(screen.getByText('Nested')).toBeDefined()
    }

    it('keeps the panel open while the pointer sweeps over a sibling row', () => {
      vi.useFakeTimers()
      renderTwoLevels()

      fireEvent.mouseEnter(screen.getByText('Plain'))
      // Still up: a diagonal sweep into the panel crosses sibling rows.
      expect(screen.getByText('Nested')).toBeDefined()

      fireEvent.mouseEnter(screen.getByTestId('context-menu-submenu'))
      act(() => vi.advanceTimersByTime(400))
      expect(screen.getByText('Nested')).toBeDefined()
    })

    it('closes the panel when the pointer stays on a sibling row', () => {
      vi.useFakeTimers()
      renderTwoLevels()

      fireEvent.mouseEnter(screen.getByText('Plain'))
      act(() => vi.advanceTimersByTime(400))
      expect(screen.queryByText('Nested')).toBeNull()
    })

    it('drops the cursor back to the parent level when a deeper panel closes', () => {
      vi.useFakeTimers()
      const root = asMenuId('test.submenu.grace.cursor')
      const sub = asMenuId('test.submenu.grace.cursor.child')
      track(MenuRegistry.addMenuItem(root, { command: 'plain.cmd', title: 'Plain' }))
      track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
      track(MenuRegistry.addMenuItem(sub, { command: 'nested.cmd', title: 'Nested' }))

      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          onClose={vi.fn()}
        />,
      )

      fireEvent.mouseEnter(screen.getByText('More'))
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowRight' })
      })
      const panel = screen.getByTestId('context-menu-submenu')
      expect(activeLabel(panel)).toBe('Nested')

      // Resting on a sibling tears the panel down; the cursor follows the mouse
      // to that sibling rather than dangling at a row that no longer exists.
      fireEvent.mouseEnter(screen.getByText('Plain'))
      act(() => vi.advanceTimersByTime(400))
      expect(screen.queryByText('Nested')).toBeNull()
      expect(activeLabel(screen.getByRole('menu'))).toBe('Plain')
    })
  })

  describe('keyboard navigation', () => {
    const press = (key: string) =>
      act(() => {
        fireEvent.keyDown(window, { key })
      })

    it('moves with the arrow keys, skipping separators and wrapping', () => {
      const root = asMenuId('test.submenu.keys.move')
      track(MenuRegistry.addMenuItem(root, { command: 'a.cmd', title: 'A', group: '1_a' }))
      track(MenuRegistry.addMenuItem(root, { command: 'b.cmd', title: 'B', group: '2_b' }))

      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          onClose={vi.fn()}
        />,
      )
      const menu = screen.getByRole('menu')

      press('ArrowDown')
      expect(activeLabel(menu)).toBe('A')
      // Index 1 is the group separator, so B is next.
      press('ArrowDown')
      expect(activeLabel(menu)).toBe('B')
      press('ArrowDown')
      expect(activeLabel(menu)).toBe('A')
      press('ArrowUp')
      expect(activeLabel(menu)).toBe('B')
    })

    it('jumps to the first and last item with Home and End', () => {
      const root = asMenuId('test.submenu.keys.homeend')
      track(MenuRegistry.addMenuItem(root, { command: 'a.cmd', title: 'A', group: '1_a' }))
      track(MenuRegistry.addMenuItem(root, { command: 'b.cmd', title: 'B', group: '2_b' }))
      track(MenuRegistry.addMenuItem(root, { command: 'c.cmd', title: 'C', group: '3_c' }))

      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          onClose={vi.fn()}
        />,
      )
      const menu = screen.getByRole('menu')

      press('End')
      expect(activeLabel(menu)).toBe('C')
      press('Home')
      expect(activeLabel(menu)).toBe('A')
    })

    it('leaves a composing Enter to the IME', () => {
      const root = asMenuId('test.submenu.keys.ime')
      track(MenuRegistry.addMenuItem(root, { command: 'run.cmd', title: 'Run' }))

      const executed: unknown[][] = []
      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService(executed)}
          onClose={vi.fn()}
        />,
      )

      press('ArrowDown')
      act(() => {
        fireEvent.keyDown(window, { key: 'Enter', isComposing: true })
      })
      expect(executed).toEqual([])

      press('Enter')
      expect(executed).toEqual([['run.cmd']])
    })

    it('opens a submenu with ArrowRight and collapses it with ArrowLeft', () => {
      const root = asMenuId('test.submenu.keys.expand')
      const sub = asMenuId('test.submenu.keys.expand.child')
      track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
      track(MenuRegistry.addMenuItem(sub, { command: 'nested.cmd', title: 'Nested' }))

      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          onClose={vi.fn()}
        />,
      )

      press('ArrowDown')
      press('ArrowRight')
      const panel = screen.getByTestId('context-menu-submenu')
      expect(activeLabel(panel)).toBe('Nested')

      press('ArrowLeft')
      expect(screen.queryByText('Nested')).toBeNull()
    })

    it('runs the active item on Enter', () => {
      const root = asMenuId('test.submenu.keys.enter')
      const sub = asMenuId('test.submenu.keys.enter.child')
      track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
      track(MenuRegistry.addMenuItem(sub, { command: 'nested.run', title: 'Run It' }))

      const executed: unknown[][] = []
      const onClose = vi.fn()
      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService(executed)}
          onClose={onClose}
        />,
      )

      press('ArrowDown')
      press('Enter')
      press('Enter')

      expect(executed).toEqual([['nested.run']])
      expect(onClose).toHaveBeenCalled()
    })

    it('peels off one submenu level per Escape before closing the menu', () => {
      const root = asMenuId('test.submenu.keys.escape')
      const sub = asMenuId('test.submenu.keys.escape.child')
      track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More' }))
      track(MenuRegistry.addMenuItem(sub, { command: 'nested.cmd', title: 'Nested' }))

      const onClose = vi.fn()
      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          onClose={onClose}
        />,
      )

      fireEvent.mouseEnter(screen.getByText('More'))
      press('Escape')
      expect(screen.queryByText('Nested')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()

      press('Escape')
      expect(onClose).toHaveBeenCalled()
    })
  })

  describe('renderIcon', () => {
    const iconSlots = (): (string | null)[] =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).map(
        (li) => li.firstElementChild?.textContent ?? null,
      )

    it('gives every row a slot — including rows with no icon — so labels align', () => {
      const root = asMenuId('test.icons.mixed')
      const sub = asMenuId('test.icons.mixed.child')
      track(
        MenuRegistry.addMenuItem(root, {
          command: 'a.cmd',
          title: 'With Icon',
          icon: 'discard',
          group: '1_a',
        }),
      )
      track(MenuRegistry.addMenuItem(root, { command: 'b.cmd', title: 'Plain', group: '1_a' }))
      track(MenuRegistry.addSubmenuItem(root, { submenu: sub, title: 'More', group: '1_a' }))
      track(MenuRegistry.addMenuItem(sub, { command: 'c.cmd', title: 'Nested' }))

      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          renderIcon={(icon) => (icon === undefined ? null : `[${icon}]`)}
          onClose={vi.fn()}
        />,
      )

      // Three rows, three slots: the icon-less one is an empty placeholder.
      expect(iconSlots()).toEqual(['[discard]', '', ''])
      // The label sits in its own element, so the row text is unchanged.
      expect(screen.getByText('With Icon')).toBeDefined()
    })

    it('renders no icon slot at all when the prop is omitted', () => {
      const root = asMenuId('test.icons.omitted')
      track(MenuRegistry.addMenuItem(root, { command: 'a.cmd', title: 'A', icon: 'discard' }))

      render(
        <ContextMenu
          menuId={root}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          onClose={vi.fn()}
        />,
      )

      const row = screen.getByRole('menuitem')
      expect(row.children).toHaveLength(1)
      expect(row.textContent).toBe('A')
    })
  })

  describe('autoFocusFirst', () => {
    /** Root menu with a leading separator: `1_a` and `2_b` are distinct groups. */
    function twoGroups(id: string) {
      const root = asMenuId(id)
      track(MenuRegistry.addMenuItem(root, { command: 'a.cmd', title: 'First', group: '1_a' }))
      track(MenuRegistry.addMenuItem(root, { command: 'b.cmd', title: 'Second', group: '2_b' }))
      return root
    }

    it('highlights the first row on open so Enter runs it straight away', () => {
      const executed: unknown[][] = []
      render(
        <ContextMenu
          menuId={twoGroups('test.autofocus.on')}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService(executed)}
          autoFocusFirst
          onClose={vi.fn()}
        />,
      )

      const menu = screen.getByRole('menu')
      expect(activeLabel(menu)).toBe('First')

      act(() => {
        fireEvent.keyDown(window, { key: 'Enter' })
      })
      expect(executed[0]?.[0]).toBe('a.cmd')
    })

    it('leaves the arrow keys stepping on from the opening highlight', () => {
      render(
        <ContextMenu
          menuId={twoGroups('test.autofocus.separator')}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          autoFocusFirst
          onClose={vi.fn()}
        />,
      )

      const menu = screen.getByRole('menu')
      expect(activeLabel(menu)).toBe('First')
      // The two entries are in different groups, so a separator sits between
      // them; the cursor steps over it rather than landing on it.
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowDown' })
      })
      expect(activeLabel(menu)).toBe('Second')
    })

    it('leaves nothing highlighted when omitted (mouse-opened menus)', () => {
      render(
        <ContextMenu
          menuId={twoGroups('test.autofocus.off')}
          anchor={{ x: 0, y: 0 }}
          commandService={makeCommandService([])}
          onClose={vi.fn()}
        />,
      )

      expect(activeLabel(screen.getByRole('menu'))).toBeNull()
      expect(document.querySelector('[role="menuitem"][data-active]')).toBeNull()
    })
  })
})
