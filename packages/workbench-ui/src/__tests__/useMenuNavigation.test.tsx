/*---------------------------------------------------------------------------------------------
 *  useMenuNavigation — 键盘归属跟随菜单自己的 window。
 *
 *  菜单可能 portal 进辅助窗口；capture 监听必须挂在该窗口上，否则那里的方向键
 *  与 Ctrl+P/N 到不了菜单，而主窗口打开的菜单反而会响应发给辅助窗口的按键。
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useMenuNavigation } from '../contextMenu/useMenuNavigation.js'
import { OwnerDocumentProvider } from '../overlay/ownerDocumentContext.js'
import type { RowModel } from '../contextMenu/menuModel.js'

afterEach(cleanup)

const ROWS: readonly RowModel[] = [
  {
    kind: 'item',
    id: 'first',
    label: 'First',
    icon: undefined,
    run: () => undefined,
  },
  {
    kind: 'item',
    id: 'second',
    label: 'Second',
    icon: undefined,
    run: () => undefined,
  },
]

function Harness({ targetDocument }: { targetDocument: Document }) {
  const nav = useMenuNavigation(ROWS, true, true, undefined, targetDocument)
  return <output data-testid="active">{JSON.stringify(nav.state.active)}</output>
}

/** Same harness, relying on OwnerDocumentProvider instead of an explicit prop. */
function ProviderHarness() {
  const nav = useMenuNavigation(ROWS, true, true)
  return <output data-testid="active">{JSON.stringify(nav.state.active)}</output>
}

function activeIndex(): number {
  const state = JSON.parse(screen.getByTestId('active').textContent ?? 'null') as {
    index: number
  } | null
  return state?.index ?? -1
}

describe('useMenuNavigation — owner window', () => {
  it('takes arrow keys from the window that hosts the menu', () => {
    const win = new Window()
    const doc = win.document as unknown as Document
    render(<Harness targetDocument={doc} />)
    expect(activeIndex()).toBe(0)

    fireEvent.keyDown(win as unknown as globalThis.Window, { key: 'ArrowDown' })
    expect(activeIndex()).toBe(1)

    fireEvent.keyDown(win as unknown as globalThis.Window, { key: 'n', ctrlKey: true })
    expect(activeIndex()).toBe(0)
  })

  it('does not answer keys from another window', () => {
    const win = new Window()
    const doc = win.document as unknown as Document
    render(<Harness targetDocument={doc} />)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(activeIndex()).toBe(0)
  })

  it('resolves the owner window from OwnerDocumentProvider', () => {
    const win = new Window()
    const doc = win.document as unknown as Document
    render(
      <OwnerDocumentProvider targetDocument={doc}>
        <ProviderHarness />
      </OwnerDocumentProvider>,
    )

    fireEvent.keyDown(win as unknown as globalThis.Window, { key: 'ArrowDown' })
    expect(activeIndex()).toBe(1)

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(activeIndex()).toBe(1)
  })
})
