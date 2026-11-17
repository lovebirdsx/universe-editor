/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for PeekNavigationContribution — the window-capture keyboard bridge
 *  that restores list navigation inside monaco's references peek.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeekNavigationContribution } from '../PeekNavigationContribution.js'

const h = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  listService: { lastFocusedList: undefined } as { lastFocusedList: unknown },
}))

vi.mock('../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    getCommandService: async () => ({ executeCommand: h.executeCommand }),
    getListService: async () => h.listService,
  },
}))

vi.mock('../../services/windows/workbenchDocumentEvents.js', () => ({
  installPerWorkbenchDocument: (attach: (doc: Document) => { dispose(): void }) => attach(document),
}))

interface FakeListHarness {
  readonly list: {
    getFocus(): unknown[]
    setSelection: ReturnType<typeof vi.fn>
    onDidChangeFocus(listener: () => void): { dispose(): void }
    reveal: ReturnType<typeof vi.fn>
    getHTMLElement(): HTMLElement
    tree: {
      getFocus(): unknown[]
      setSelection: ReturnType<typeof vi.fn>
      focusNext: ReturnType<typeof vi.fn>
      focusPrevious: ReturnType<typeof vi.fn>
      onLeftArrow: ReturnType<typeof vi.fn>
      onRightArrow: ReturnType<typeof vi.fn>
    }
  }
  setFocus(items: unknown[]): void
}

function makeFakeList(host: HTMLElement, items: readonly unknown[]): FakeListHarness {
  let focus: unknown[] = items[0] === undefined ? [] : [items[0]]
  const listeners = new Set<() => void>()
  const setFocus = (next: unknown[]): void => {
    focus = next
    for (const listener of listeners) listener()
  }
  const step = (delta: number): void => {
    const current = focus[0]
    const index = current === undefined ? -1 : items.indexOf(current)
    const next = items[Math.max(0, Math.min(items.length - 1, index + delta))]
    if (next !== undefined) setFocus([next])
  }
  return {
    list: {
      getFocus: () => [...focus],
      setSelection: vi.fn(),
      onDidChangeFocus: (listener: () => void) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
      reveal: vi.fn(),
      getHTMLElement: () => host,
      // ReferencesTree extends AsyncDataTree: the arrow methods live on the
      // wrapped AbstractTree (`tree`), not on the list wrapper.
      tree: {
        getFocus: () => [...focus],
        setSelection: vi.fn(),
        focusNext: vi.fn(() => step(1)),
        focusPrevious: vi.fn(() => step(-1)),
        onLeftArrow: vi.fn(),
        onRightArrow: vi.fn(),
      },
    },
    setFocus,
  }
}

let contribution: PeekNavigationContribution | undefined

beforeEach(() => {
  document.body.innerHTML = ''
  const tree = document.createElement('div')
  tree.className = 'ref-tree'
  const listHost = document.createElement('div')
  listHost.tabIndex = 0
  tree.append(listHost)
  document.body.append(tree)
  listHost.focus()
  h.listService.lastFocusedList = undefined
})

afterEach(() => {
  contribution?.dispose()
  contribution = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function createContribution(list: unknown): Promise<void> {
  h.listService.lastFocusedList = list
  contribution = new PeekNavigationContribution()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const target = document.activeElement
  if (!(target instanceof HTMLElement)) throw new Error('no focused element')
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

function focusedTreeHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>('.ref-tree > div')
  if (!host) throw new Error('missing tree host')
  return host
}

describe('PeekNavigationContribution Ctrl navigation', () => {
  it('Ctrl+J moves to the next reference and mirrors it into the selection', async () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const { list } = makeFakeList(focusedTreeHost(), items)
    await createContribution(list)

    const event = press('j', { ctrlKey: true })

    expect(list.tree.focusNext).toHaveBeenCalledWith(1, false, event)
    expect(list.setSelection).toHaveBeenCalledWith([items[1]], event)
    expect(list.reveal).toHaveBeenCalledWith(items[1])
    expect(event.defaultPrevented).toBe(true)
  })

  it('Ctrl+K moves to the previous reference and mirrors it into the selection', async () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const { list, setFocus } = makeFakeList(focusedTreeHost(), items)
    setFocus([items[1]])
    await createContribution(list)

    const event = press('k', { ctrlKey: true })

    expect(list.tree.focusPrevious).toHaveBeenCalledWith(1, false, event)
    expect(list.setSelection).toHaveBeenCalledWith([items[0]], event)
    expect(list.reveal).toHaveBeenCalledWith(items[0])
    expect(event.defaultPrevented).toBe(true)
  })

  it('Ctrl+L expands via monaco onRightArrow and mirrors a focus move', async () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const { list, setFocus } = makeFakeList(focusedTreeHost(), items)
    list.tree.onRightArrow.mockImplementation(() => setFocus([items[1]]))
    await createContribution(list)

    const event = press('l', { ctrlKey: true })

    expect(list.tree.onRightArrow).toHaveBeenCalledWith(event)
    expect(list.setSelection).toHaveBeenCalledWith([items[1]], event)
    expect(list.reveal).toHaveBeenCalledWith(items[1])
    expect(event.defaultPrevented).toBe(true)
  })

  it('Ctrl+H collapses via monaco onLeftArrow and mirrors a focus move', async () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const { list, setFocus } = makeFakeList(focusedTreeHost(), items)
    setFocus([items[1]])
    list.tree.onLeftArrow.mockImplementation(() => setFocus([items[0]]))
    await createContribution(list)

    const event = press('h', { ctrlKey: true })

    expect(list.tree.onLeftArrow).toHaveBeenCalledWith(event)
    expect(list.setSelection).toHaveBeenCalledWith([items[0]], event)
    expect(list.reveal).toHaveBeenCalledWith(items[0])
    expect(event.defaultPrevented).toBe(true)
  })

  it('swallows Ctrl+L without mirroring when expanding leaves focus in place', async () => {
    const { list } = makeFakeList(focusedTreeHost(), [{ id: 'a' }])
    await createContribution(list)

    const event = press('l', { ctrlKey: true })

    expect(list.tree.onRightArrow).toHaveBeenCalledWith(event)
    expect(list.setSelection).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it.each([
    { label: 'Shift', init: { ctrlKey: true, shiftKey: true } },
    { label: 'Alt', init: { ctrlKey: true, altKey: true } },
    { label: 'Meta', init: { ctrlKey: true, metaKey: true } },
    { label: 'Alt alone', init: { altKey: true } },
  ])('ignores strokes carrying $label', async ({ init }) => {
    const { list } = makeFakeList(focusedTreeHost(), [{ id: 'a' }])
    await createContribution(list)

    const event = press('j', init)

    expect(list.tree.focusNext).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores IME composition', async () => {
    const { list } = makeFakeList(focusedTreeHost(), [{ id: 'a' }])
    await createContribution(list)

    const composing = new KeyboardEvent('keydown', {
      key: 'j',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    document.activeElement?.dispatchEvent(composing)
    expect(list.tree.focusNext).not.toHaveBeenCalled()

    const legacy = new KeyboardEvent('keydown', {
      key: 'j',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(legacy, 'keyCode', { value: 229 })
    document.activeElement?.dispatchEvent(legacy)
    expect(list.tree.focusNext).not.toHaveBeenCalled()
  })

  it('ignores strokes already claimed by another window listener', async () => {
    const { list } = makeFakeList(focusedTreeHost(), [{ id: 'a' }])
    await createContribution(list)

    const event = new KeyboardEvent('keydown', {
      key: 'j',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    event.preventDefault()
    document.activeElement?.dispatchEvent(event)

    expect(list.tree.focusNext).not.toHaveBeenCalled()
  })

  it('ignores strokes outside the references tree', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    const { list } = makeFakeList(focusedTreeHost(), [{ id: 'a' }])
    await createContribution(list)

    const event = press('j', { ctrlKey: true })

    expect(list.tree.focusNext).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores a lastFocusedList that does not own the focused element', async () => {
    const otherHost = document.createElement('div')
    document.body.append(otherHost)
    const { list } = makeFakeList(otherHost, [{ id: 'a' }])
    await createContribution(list)

    const event = press('j', { ctrlKey: true })

    expect(list.tree.focusNext).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('does nothing when the list service has no focused list', async () => {
    await createContribution(undefined)

    expect(() => press('j', { ctrlKey: true })).not.toThrow()
  })

  it('still mirrors bare arrow navigation through the focus listener', async () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const { list, setFocus } = makeFakeList(focusedTreeHost(), items)
    await createContribution(list)

    const event = press('ArrowDown')
    expect(list.tree.focusNext).not.toHaveBeenCalled()

    setFocus([items[1]])

    expect(list.setSelection).toHaveBeenCalledWith([items[1]], event)
  })

  it('still follows leaf references on Enter and leaves group headers alone', async () => {
    document.body.innerHTML = ''
    const tree = document.createElement('div')
    tree.className = 'ref-tree'
    const row = document.createElement('div')
    row.className = 'monaco-list-row'
    const leaf = document.createElement('div')
    leaf.tabIndex = 0
    row.append(leaf)
    tree.append(row)
    document.body.append(tree)
    leaf.focus()

    const { list } = makeFakeList(tree, [{ id: 'a' }])
    await createContribution(list)

    press('Enter')
    expect(h.executeCommand).toHaveBeenCalledWith('openReference')

    h.executeCommand.mockClear()
    const twistie = document.createElement('span')
    twistie.className = 'monaco-tl-twistie collapsible'
    row.append(twistie)
    press('Enter')
    expect(h.executeCommand).not.toHaveBeenCalled()
  })
})
