/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the shared Ctrl-alias arbitration. The registry is the one place that
 *  decides which surface a Ctrl+P/N/J/K/H/L stroke belongs to.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { StrictMode, useRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  __getCtrlNavigationLayerCountForTests,
  __resetCtrlNavigationForTests,
  useCtrlNavigationLayer,
  type CtrlNavigationLayerKind,
  type ICtrlNavigationLayerOptions,
} from '../keybinding/ctrlNavigationRegistry.js'
import type { CtrlNavigationDirection } from '../keybinding/ctrlNavigation.js'

afterEach(() => {
  cleanup()
  __resetCtrlNavigationForTests()
})

type LayerProps = {
  readonly kind: CtrlNavigationLayerKind
  readonly onMove: (direction: CtrlNavigationDirection, event: KeyboardEvent) => void
  readonly testId?: string
  readonly directions?: readonly CtrlNavigationDirection[]
  readonly enabled?: boolean
  readonly focus?: 'self' | 'within'
  readonly allowEditableFocus?: boolean
  readonly targetDocument?: Document
  readonly withElement?: boolean
}

function Layer({
  kind,
  onMove,
  testId = 'surface',
  directions = ['up', 'down', 'left', 'right'],
  enabled = true,
  focus,
  allowEditableFocus,
  targetDocument,
  withElement = true,
}: LayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const options: ICtrlNavigationLayerOptions = {
    kind,
    directions,
    onMove,
    enabled,
    ...(focus !== undefined ? { focus } : {}),
    ...(allowEditableFocus !== undefined ? { allowEditableFocus } : {}),
    ...(withElement ? { getElement: () => ref.current } : {}),
    ...(targetDocument !== undefined ? { targetDocument } : {}),
  }
  useCtrlNavigationLayer(options)
  return withElement ? <div ref={ref} tabIndex={0} data-testid={testId} /> : null
}

function press(
  key: string,
  mods: Partial<Record<'ctrl' | 'alt' | 'meta' | 'shift', boolean>> = { ctrl: true },
  target: Window | typeof window = window,
): boolean {
  return fireEvent.keyDown(target as unknown as globalThis.Window, {
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
  })
}

describe('useCtrlNavigationLayer — routing', () => {
  it('routes Ctrl+N/J to down and Ctrl+P/K to up on an active list', () => {
    const onMove = vi.fn()
    render(<Layer kind="list" onMove={onMove} />)
    const surface = document.querySelector('[data-testid="surface"]') as HTMLElement
    surface.focus()

    for (const [key, direction] of [
      ['n', 'down'],
      ['j', 'down'],
      ['p', 'up'],
      ['k', 'up'],
    ] as const) {
      onMove.mockClear()
      press(key)
      expect(onMove).toHaveBeenCalledTimes(1)
      expect(onMove).toHaveBeenCalledWith(direction, expect.anything())
    }
  })

  it('rejects extra modifiers, bare letters and non-alias Ctrl strokes', () => {
    const onMove = vi.fn()
    render(<Layer kind="list" onMove={onMove} />)
    const surface = document.querySelector('[data-testid="surface"]') as HTMLElement
    surface.focus()

    press('j', { ctrl: true, shift: true })
    press('j', { ctrl: true, alt: true })
    press('j', { meta: true })
    press('j', {})
    press('b', { ctrl: true })
    press('ArrowDown', { ctrl: true })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('takes the stroke only while the list container itself is focused', () => {
    const onMove = vi.fn()
    render(
      <>
        <Layer kind="list" onMove={onMove} focus="self" />
        <input data-testid="editor" />
      </>,
    )
    const surface = document.querySelector('[data-testid="surface"]') as HTMLElement
    const editor = document.querySelector('[data-testid="editor"]') as HTMLInputElement

    editor.focus()
    press('j')
    expect(onMove).not.toHaveBeenCalled()

    surface.focus()
    press('j')
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('does not claim strokes from an editable target inside a within-layer', () => {
    const onMove = vi.fn()
    render(<EditableLayer onMove={onMove} />)
    const editor = document.querySelector('[data-testid="inner-editor"]') as HTMLInputElement
    editor.focus()
    press('j')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('lets a dialog whose rows are checkboxes opt into editable focus', () => {
    const onMove = vi.fn()
    render(<EditableLayer onMove={onMove} allowEditableFocus inputType="checkbox" />)
    const checkbox = document.querySelector('[data-testid="inner-editor"]') as HTMLInputElement
    checkbox.focus()
    press('j')
    expect(onMove).toHaveBeenCalledTimes(1)
  })
})

function EditableLayer({
  onMove,
  allowEditableFocus,
  inputType = 'text',
}: {
  readonly onMove: (direction: CtrlNavigationDirection, event: KeyboardEvent) => void
  readonly allowEditableFocus?: boolean
  readonly inputType?: string
}) {
  // The wrapper is the layer element; the editable control lives inside it.
  const ref = useRef<HTMLDivElement>(null)
  useCtrlNavigationLayer({
    kind: 'list',
    focus: 'within',
    directions: ['up', 'down'],
    onMove,
    ...(allowEditableFocus !== undefined ? { allowEditableFocus } : {}),
    getElement: () => ref.current,
  })
  return (
    <div ref={ref} tabIndex={0}>
      <input type={inputType} data-testid="inner-editor" />
    </div>
  )
}

describe('useCtrlNavigationLayer — arbitration', () => {
  it('lets a menu with virtual focus beat the tree that still holds DOM focus', () => {
    const listMove = vi.fn()
    const menuMove = vi.fn()
    render(
      <>
        <Layer kind="list" onMove={listMove} testId="tree" />
        <Layer kind="menu" onMove={menuMove} withElement={false} />
      </>,
    )
    const tree = document.querySelector('[data-testid="tree"]') as HTMLElement
    tree.focus()

    press('j')
    expect(menuMove).toHaveBeenCalledTimes(1)
    expect(listMove).not.toHaveBeenCalled()
  })

  it('picks the innermost of nested overlays', () => {
    const outerMove = vi.fn()
    const innerMove = vi.fn()
    function Nested() {
      const outer = useRef<HTMLDivElement>(null)
      const inner = useRef<HTMLDivElement>(null)
      useCtrlNavigationLayer({
        kind: 'overlay',
        focus: 'within',
        directions: ['up', 'down'],
        getElement: () => outer.current,
        onMove: outerMove,
      })
      useCtrlNavigationLayer({
        kind: 'overlay',
        focus: 'within',
        directions: ['up', 'down'],
        getElement: () => inner.current,
        onMove: innerMove,
      })
      return (
        <div ref={outer}>
          <div ref={inner} tabIndex={0} data-testid="inner" />
        </div>
      )
    }
    render(<Nested />)
    ;(document.querySelector('[data-testid="inner"]') as HTMLElement).focus()

    press('k')
    expect(innerMove).toHaveBeenCalledTimes(1)
    expect(outerMove).not.toHaveBeenCalled()
  })

  it('leaves a direction to a layer that implements it (Tree has no horizontal aliases)', () => {
    const listMove = vi.fn()
    render(<Layer kind="list" onMove={listMove} directions={['up', 'down']} />)
    ;(document.querySelector('[data-testid="surface"]') as HTMLElement).focus()

    press('h')
    press('l')
    expect(listMove).not.toHaveBeenCalled()
    // Not claimed: the global replace / select-line bindings stay reachable.
    expect(press('h')).toBe(true)
  })

  it('claims the stroke even when the surface has nowhere to move', () => {
    const onMove = vi.fn()
    render(<Layer kind="list" onMove={onMove} />)
    ;(document.querySelector('[data-testid="surface"]') as HTMLElement).focus()

    expect(press('j')).toBe(false)
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('ignores a stroke another listener already prevented', () => {
    const onMove = vi.fn()
    render(<Layer kind="list" onMove={onMove} />)
    ;(document.querySelector('[data-testid="surface"]') as HTMLElement).focus()

    const event = new KeyboardEvent('keydown', {
      key: 'j',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('ignores IME composition strokes', () => {
    const onMove = vi.fn()
    render(<Layer kind="list" onMove={onMove} />)
    ;(document.querySelector('[data-testid="surface"]') as HTMLElement).focus()

    fireEvent.keyDown(window, { key: 'j', ctrlKey: true, keyCode: 229 })
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('useCtrlNavigationLayer — lifecycle', () => {
  it('installs one listener and removes it with the last layer', () => {
    const view = render(<Layer kind="list" onMove={vi.fn()} />)
    expect(__getCtrlNavigationLayerCountForTests(document)).toBe(1)
    view.unmount()
    expect(__getCtrlNavigationLayerCountForTests(document)).toBe(0)
  })

  it('does not register while disabled', () => {
    const view = render(<Layer kind="menu" onMove={vi.fn()} enabled={false} withElement={false} />)
    expect(__getCtrlNavigationLayerCountForTests(document)).toBe(0)
    view.rerender(<Layer kind="menu" onMove={vi.fn()} enabled withElement={false} />)
    expect(__getCtrlNavigationLayerCountForTests(document)).toBe(1)
  })

  it('survives StrictMode double-mounting without moving twice', () => {
    const onMove = vi.fn()
    render(
      <StrictMode>
        <Layer kind="list" onMove={onMove} />
      </StrictMode>,
    )
    ;(document.querySelector('[data-testid="surface"]') as HTMLElement).focus()
    press('j')
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('keeps documents isolated', () => {
    const win = new Window()
    const doc = win.document as unknown as Document
    const container = doc.createElement('div')
    doc.body.appendChild(container)
    const auxMove = vi.fn()
    render(<Layer kind="list" onMove={auxMove} targetDocument={doc} />, { container })

    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement
    surface.focus()

    press('j', { ctrl: true }, win)
    expect(auxMove).toHaveBeenCalledTimes(1)
    expect(__getCtrlNavigationLayerCountForTests(document)).toBe(0)

    press('j')
    expect(auxMove).toHaveBeenCalledTimes(1)
  })
})
