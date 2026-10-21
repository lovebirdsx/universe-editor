/*---------------------------------------------------------------------------------------------
 *  useFindInContainer writes CSS Custom Highlight ranges into the registry of the
 *  container's own document. An auxiliary window has its own `CSS.highlights`;
 *  writing into the main registry would highlight nothing there (and leak ranges
 *  into the main document's registry).
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useFindInContainer, type FindInContainerState } from '../useFindInContainer.js'

interface FakeHighlight {
  add(range: Range): void
}

class FakeHighlightImpl implements FakeHighlight {
  readonly ranges: Range[] = []
  add(range: Range): void {
    this.ranges.push(range)
  }
}

function fakeRegistry(): {
  set: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
} {
  return { set: vi.fn(), delete: vi.fn() }
}

/** An auxiliary document whose defaultView owns the highlight APIs. */
function auxiliaryDocument(registry: ReturnType<typeof fakeRegistry>): Document {
  const doc = document.implementation.createHTMLDocument('aux')
  Object.defineProperty(doc, 'defaultView', {
    value: { CSS: { highlights: registry }, Highlight: FakeHighlightImpl },
    configurable: true,
  })
  return doc
}

function Harness({
  root,
  onState,
}: {
  root: HTMLElement
  onState: (state: FindInContainerState) => void
}): null {
  const ref = useRef<HTMLElement | null>(root)
  onState(useFindInContainer(ref, 0, { hlAll: 'find-all', hlCurrent: 'find-current' }, () => {}))
  return null
}

/** Like {@link Harness} but the container ref can be nulled mid-test. */
function RefHarness({
  rootRef,
  onState,
}: {
  rootRef: { current: HTMLElement | null }
  onState: (state: FindInContainerState) => void
}): null {
  onState(
    useFindInContainer(rootRef, 0, { hlAll: 'find-all', hlCurrent: 'find-current' }, () => {}),
  )
  return null
}

afterEach(() => {
  cleanup()
})

describe('useFindInContainer highlight ownership', () => {
  it('writes and clears highlights in the owner document’s registry', () => {
    const ownerRegistry = fakeRegistry()
    const doc = auxiliaryDocument(ownerRegistry)
    const root = doc.createElement('div')
    root.textContent = 'needle in the aux document'
    doc.body.appendChild(root)

    let state!: FindInContainerState
    render(<Harness root={root} onState={(s) => (state = s)} />)

    act(() => state.open())
    act(() => state.setQuery('needle'))

    expect(state.count).toBe(1)
    expect(ownerRegistry.set).toHaveBeenCalledWith('find-all', expect.any(FakeHighlightImpl))
    expect(ownerRegistry.set).toHaveBeenCalledWith('find-current', expect.any(FakeHighlightImpl))
    // The sole match is the current one, so it belongs to the current highlight.
    const currentHighlights = ownerRegistry.set.mock.calls
      .filter(([name]) => name === 'find-current')
      .at(-1)?.[1]
    expect((currentHighlights as FakeHighlightImpl).ranges.length).toBe(1)

    act(() => state.close())
    expect(ownerRegistry.delete).toHaveBeenCalledWith('find-all')
    expect(ownerRegistry.delete).toHaveBeenCalledWith('find-current')
  })

  it('does not write into the main window registry for an auxiliary container', () => {
    const ownerRegistry = fakeRegistry()
    const globalRegistry = fakeRegistry()
    vi.stubGlobal('CSS', { highlights: globalRegistry })
    vi.stubGlobal('Highlight', FakeHighlightImpl)
    try {
      const doc = auxiliaryDocument(ownerRegistry)
      const root = doc.createElement('div')
      root.textContent = 'needle'
      doc.body.appendChild(root)

      let state!: FindInContainerState
      render(<Harness root={root} onState={(s) => (state = s)} />)
      act(() => state.open())
      act(() => state.setQuery('needle'))

      expect(ownerRegistry.set).toHaveBeenCalled()
      expect(globalRegistry.set).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('clears the owner registry when unmounted without close', () => {
    const ownerRegistry = fakeRegistry()
    const doc = auxiliaryDocument(ownerRegistry)
    const root = doc.createElement('div')
    root.textContent = 'needle'
    doc.body.appendChild(root)

    let state!: FindInContainerState
    const { unmount } = render(<Harness root={root} onState={(s) => (state = s)} />)
    act(() => state.open())
    act(() => state.setQuery('needle'))
    ownerRegistry.delete.mockClear()

    unmount()

    expect(ownerRegistry.delete).toHaveBeenCalledWith('find-all')
    expect(ownerRegistry.delete).toHaveBeenCalledWith('find-current')
  })

  it('re-anchors on a match document when the container unmounted mid-navigation', () => {
    const ownerRegistry = fakeRegistry()
    const doc = auxiliaryDocument(ownerRegistry)
    const root = doc.createElement('div')
    root.textContent = 'needle needle'
    doc.body.appendChild(root)

    const rootRef: { current: HTMLElement | null } = { current: root }
    let state!: FindInContainerState
    render(<RefHarness rootRef={rootRef} onState={(s) => (state = s)} />)
    act(() => state.open())
    act(() => state.setQuery('needle'))
    expect(state.count).toBe(2)

    rootRef.current = null
    const callsBefore = ownerRegistry.set.mock.calls.length
    act(() => state.next())

    expect(ownerRegistry.set.mock.calls.length).toBeGreaterThan(callsBefore)
  })
})
