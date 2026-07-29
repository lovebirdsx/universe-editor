/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression: entering the markdown preview aligned to the source cursor
 *  (Ctrl+Shift+V) reset to the top under `pnpm dev`. main.tsx wraps the app in
 *  <StrictMode>, which runs the restore effect through a throwaway setup→cleanup
 *  cycle before the real one; the preview's markdown also renders asynchronously,
 *  so the first effect pass sees no `data-line` blocks to map the reveal line
 *  against. The old code read-and-deleted the one-shot reveal request on the very
 *  first read, so the throwaway/empty pass swallowed it before it ever scrolled —
 *  and the real pass, finding nothing, left the preview at the top.
 *
 *  E2E didn't catch it because E2E runs the *production* build, where StrictMode
 *  is off. These tests mount the extracted restore hook under <StrictMode> and
 *  lay content out after mount to mirror that dev-only double invoke + async
 *  layout, driving the re-apply through a controllable ResizeObserver stub
 *  (happy-dom's doesn't fire on DOM mutations).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { URI } from '@universe-editor/platform'
import { MarkdownPreviewViewStateCache } from '../../../services/editor/MarkdownPreviewViewStateCache.js'
import { MarkdownPreviewRegistry } from '../../../services/editor/MarkdownPreviewRegistry.js'
import { useMarkdownPreviewScrollRestore } from '../useMarkdownPreviewScrollRestore.js'

// Capture every live ResizeObserver so a test can fire its callback on demand,
// standing in for the layout notification happy-dom never emits.
const observers: Array<() => void> = []

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {
    observers.push(this.cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    const i = observers.indexOf(this.cb)
    if (i !== -1) observers.splice(i, 1)
  }
}

function fireResizeObservers(): void {
  for (const cb of [...observers]) cb()
}

// happy-dom leaves getBoundingClientRect at zeros and doesn't lay content out.
// Stub the geometry collectEntries reads: root at top 0, and each `data-line`
// block spaced 20px apart so line N maps to a distinct scrollTop. Block tops
// track root.scrollTop like a real layout would, so re-applies stay stable.
function stubGeometry(root: HTMLElement): void {
  root.getBoundingClientRect = (() =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect) as never
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-line]'))
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    b.getBoundingClientRect = (() =>
      ({
        top: i * 20 - root.scrollTop,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect) as never
  }
}

// Stand-in for MarkdownPreviewEditor's structure: a scroll container whose
// markdown blocks appear *after* mount (async), each carrying a data-line —
// mirroring the real component reading its model in a useEffect. When
// `anchorId` is set, block 5 renders as a heading carrying that data-anchor
// (top = 5 * 20 = 100 under stubGeometry).
function Host({ stateKey, anchorId }: { stateKey: string; anchorId?: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useMarkdownPreviewScrollRestore(rootRef, stateKey)

  useEffect(() => {
    setReady(true)
  }, [])

  useEffect(() => {
    if (rootRef.current && ready) stubGeometry(rootRef.current)
  }, [ready])

  return (
    <div ref={rootRef} data-testid="preview">
      {ready && (
        <div>
          {Array.from({ length: 20 }, (_, i) =>
            i === 5 && anchorId !== undefined ? (
              <h2 key={i} data-line={i} data-anchor={anchorId}>
                anchor heading
              </h2>
            ) : (
              <p key={i} data-line={i}>
                paragraph {i}
              </p>
            ),
          )}
        </div>
      )}
    </div>
  )
}

const KEY = 'file:///repo/doc.md'
let RealResizeObserver: typeof ResizeObserver | undefined

beforeEach(() => {
  RealResizeObserver = globalThis.ResizeObserver
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  cleanup()
  observers.length = 0
  MarkdownPreviewViewStateCache._resetForTests()
  MarkdownPreviewRegistry._resetForTests()
  if (RealResizeObserver) globalThis.ResizeObserver = RealResizeObserver
})

describe('useMarkdownPreviewScrollRestore — reveal survives StrictMode + async content', () => {
  it('scrolls to the reveal line even though content lays out after mount (StrictMode)', () => {
    // Enter-preview stashed a reveal for source line 11 (0-based data-line 10 ->
    // 1-based 11), which stubGeometry maps to top = 10 * 20 = 200.
    MarkdownPreviewViewStateCache.saveRevealLine(KEY, 11)

    const { container } = render(
      <StrictMode>
        <Host stateKey={KEY} />
      </StrictMode>,
    )
    const root = container.querySelector<HTMLElement>('[data-testid="preview"]')!

    // The restore effect's initial apply ran while the blocks were still absent
    // (async content) and, under StrictMode, through a throwaway pass first. The
    // reveal must NOT have been consumed then — so the layout notification can
    // finally scroll the preview to line 11's offset.
    act(() => {
      fireResizeObservers()
    })

    expect(root.scrollTop).toBe(200)
    // One-shot: consumed once applied, so a later remount won't re-reveal.
    expect(MarkdownPreviewViewStateCache.peekRevealLine(KEY)).toBeUndefined()
  })

  it('keeps the reveal request pending while there are no data-line blocks to map', () => {
    MarkdownPreviewViewStateCache.saveRevealLine(KEY, 11)

    const { container } = render(
      <StrictMode>
        <Host stateKey={KEY} />
      </StrictMode>,
    )
    const root = container.querySelector<HTMLElement>('[data-testid="preview"]')!
    // Strip the blocks back out before firing the observer, so every apply sees
    // empty content — the request must never be silently dropped.
    root.replaceChildren()

    act(() => {
      fireResizeObservers()
    })

    expect(root.scrollTop).toBe(0)
    expect(MarkdownPreviewViewStateCache.peekRevealLine(KEY)).toBe(11)
  })
})

describe('useMarkdownPreviewScrollRestore — cross-file anchor vs saved scrollTop', () => {
  // Regression: clicking a `b.md#h6` link in a.md's preview, navigating back,
  // then clicking a `b.md#h2` link landed on h6 again — the restore effect
  // re-applied b.md's saved scrollTop (kept alive for 600ms by the
  // ResizeObserver) on top of the freshly requested anchor.
  it('a pending cross-file anchor wins over the saved scrollTop', () => {
    // b.md was left scrolled at 240 by the first anchor jump…
    MarkdownPreviewViewStateCache.save(KEY, { scrollTop: 240 })
    // …then a link carrying a *different* fragment opened it while unmounted.
    MarkdownPreviewRegistry.revealAnchor(URI.parse(KEY), 'jump-target')

    const { container } = render(
      <StrictMode>
        <Host stateKey={KEY} anchorId="jump-target" />
      </StrictMode>,
    )
    const root = container.querySelector<HTMLElement>('[data-testid="preview"]')!

    act(() => {
      fireResizeObservers()
    })

    // Anchor block sits at 5 * 20 = 100 — the saved 240 must not win.
    expect(root.scrollTop).toBe(100)
    // The landing becomes the new saved position, so a plain tab switch back
    // returns here instead of the pre-jump offset.
    expect(MarkdownPreviewViewStateCache.load(KEY)?.scrollTop).toBe(100)
  })

  it('re-applies the anchor position while late content keeps growing', () => {
    MarkdownPreviewViewStateCache.save(KEY, { scrollTop: 240 })
    MarkdownPreviewRegistry.revealAnchor(URI.parse(KEY), 'jump-target')

    const { container } = render(
      <StrictMode>
        <Host stateKey={KEY} anchorId="jump-target" />
      </StrictMode>,
    )
    const root = container.querySelector<HTMLElement>('[data-testid="preview"]')!

    act(() => {
      fireResizeObservers()
    })
    // Simulate a user-less nudge (late mermaid/code layout shifting scrollTop):
    // the restore window must pin the anchor position again, not the saved one.
    root.scrollTop = 0
    act(() => {
      fireResizeObservers()
    })

    expect(root.scrollTop).toBe(100)
  })

  it('an anchor that does not exist in the laid-out content falls back to the saved scrollTop', () => {
    MarkdownPreviewViewStateCache.save(KEY, { scrollTop: 240 })
    MarkdownPreviewRegistry.revealAnchor(URI.parse(KEY), 'no-such-anchor')

    const { container } = render(
      <StrictMode>
        <Host stateKey={KEY} />
      </StrictMode>,
    )
    const root = container.querySelector<HTMLElement>('[data-testid="preview"]')!

    act(() => {
      fireResizeObservers()
    })

    expect(root.scrollTop).toBe(240)
  })

  it('keeps the anchor request pending while content has not laid out', () => {
    MarkdownPreviewRegistry.revealAnchor(URI.parse(KEY), 'jump-target')

    const { container } = render(
      <StrictMode>
        <Host stateKey={KEY} anchorId="jump-target" />
      </StrictMode>,
    )
    const root = container.querySelector<HTMLElement>('[data-testid="preview"]')!
    // Strip the blocks back out before firing the observer, so every apply sees
    // empty content — the one-shot must survive for the next (real) mount.
    root.replaceChildren()

    act(() => {
      fireResizeObservers()
    })

    expect(root.scrollTop).toBe(0)
    const remount = render(
      <StrictMode>
        <Host stateKey={KEY} anchorId="jump-target" />
      </StrictMode>,
    )
    const root2 = remount.container.querySelector<HTMLElement>('[data-testid="preview"]')!
    act(() => {
      fireResizeObservers()
    })
    expect(root2.scrollTop).toBe(100)
  })
})
