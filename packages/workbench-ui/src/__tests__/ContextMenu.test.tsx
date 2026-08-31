import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
