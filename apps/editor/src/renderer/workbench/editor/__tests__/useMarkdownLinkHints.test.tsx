/*---------------------------------------------------------------------------------------------
 *  useMarkdownLinkHints — auxiliary-window linking.
 *
 *  The preview may live in an auxiliary editor window: its anchors are shape-
 *  compatible but not `instanceof HTMLAnchorElement`, and keyboard events travel
 *  through that window's document, not the main one. `happy-dom` shares DOM
 *  constructors across `new Window()`, so the shape test uses a pure double;
 *  the document-scope test uses a separate happy-dom Window to prove the
 *  listener follows the root's ownerDocument.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { act, cleanup, renderHook } from '@testing-library/react'
import { collectVisibleLinks, useMarkdownLinkHints } from '../useMarkdownLinkHints.js'
import { DEFAULT_HINT_CHARS, generateHintLabels } from '../markdownLinkHints.js'

function rect(top: number, left: number, right: number, bottom: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect
}

afterEach(() => cleanup())

describe('collectVisibleLinks', () => {
  it('collects a foreign-realm anchor by shape', () => {
    const anchor = {
      nodeType: 1,
      tagName: 'A',
      getBoundingClientRect: () => rect(10, 10, 100, 20),
    } as unknown as HTMLAnchorElement
    const root = {
      getBoundingClientRect: () => rect(0, 0, 1000, 1000),
      querySelectorAll: () => [anchor, { nodeType: 3 }],
    } as unknown as HTMLElement

    expect(collectVisibleLinks(root)).toEqual([anchor])
  })
})

describe('useMarkdownLinkHints — listener scope', () => {
  it('owns the keyboard on the root document of an auxiliary window', () => {
    const win = new Window()
    const doc = win.document as unknown as Document
    const root = doc.createElement('div') as HTMLElement
    root.getBoundingClientRect = () => rect(0, 0, 1000, 1000)
    doc.body.appendChild(root)

    const clicks: string[] = []
    for (const [name, href] of [
      ['a', 'https://example.com/a'],
      ['b', 'https://example.com/b'],
    ] as const) {
      const anchor = doc.createElement('a')
      anchor.setAttribute('href', href)
      anchor.getBoundingClientRect = () => rect(10, 10, 100, 20)
      anchor.addEventListener('click', () => clicks.push(name))
      root.appendChild(anchor)
    }

    const rootRef = { current: root }
    const { result } = renderHook(() => useMarkdownLinkHints(rootRef), { container: doc.body })

    act(() => result.current.show(false))
    expect(result.current.markers).toHaveLength(2)

    // The label for the first link is a single home-row character; pressing it
    // follows that link via the synthetic click.
    const label = generateHintLabels(2, DEFAULT_HINT_CHARS)[0]!
    expect(label).toHaveLength(1)

    // The main document is not the preview's document: its keys must not reach
    // this hook (otherwise a preview in another window would steal main keys).
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: label, bubbles: true, cancelable: true }),
      )
    })
    expect(clicks).toHaveLength(0)

    act(() => {
      doc.dispatchEvent(
        new win.KeyboardEvent('keydown', {
          key: label,
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      )
    })
    expect(clicks).toEqual(['a'])
  })
})
