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
import { MarkdownPreviewViewStateCache } from '../../../services/editor/MarkdownPreviewViewStateCache.js'
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
// block spaced 20px apart so line N maps to a distinct scrollTop.
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
        top: i * 20,
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
// mirroring the real component reading its model in a useEffect.
function Host({ stateKey }: { stateKey: string }) {
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
          {Array.from({ length: 20 }, (_, i) => (
            <p key={i} data-line={i}>
              paragraph {i}
            </p>
          ))}
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
