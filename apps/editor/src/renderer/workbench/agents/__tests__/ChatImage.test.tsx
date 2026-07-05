/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ChatImage — the shared 88×88 thumbnail + click-to-open preview
 *  popover used by both the message body and the prompt attachment chips.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatImage, computeDisplaySize } from '../ChatImage.js'

const SRC = 'data:image/png;base64,YWJjZA=='

afterEach(() => {
  cleanup()
})

function stubWindowSize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

function stubNaturalSize(img: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
}

describe('computeDisplaySize', () => {
  it('grows a small image to the min box, preserving aspect ratio', () => {
    const size = computeDisplaySize(50, 50, 420, 420, 1072, 640)
    expect(size).toEqual({ width: 420, height: 420, isLarge: false })
  })

  it('shrinks a large image to the max box, preserving aspect ratio', () => {
    const size = computeDisplaySize(4000, 3000, 420, 420, 1072, 640)
    // Height is the binding constraint: 640 / 3000 < 1072 / 4000.
    expect(size.height).toBe(640)
    expect(size.width).toBeCloseTo((4000 / 3000) * 640, 5)
    expect(size.isLarge).toBe(true)
  })

  it('leaves a mid-sized image at its natural size', () => {
    const size = computeDisplaySize(600, 500, 420, 420, 1072, 640)
    expect(size).toEqual({ width: 600, height: 500, isLarge: false })
  })

  it('lets the max box win over the min box for extreme aspect ratios', () => {
    // A very tall, narrow image: shrinking to fit the max height would drop the
    // width below the min box, but growing back up to the min width would blow
    // past the max height — the max box must win so the popover never overflows.
    const size = computeDisplaySize(50, 2000, 420, 420, 1072, 640)
    expect(size.height).toBeLessThanOrEqual(640)
    expect(size.width).toBeLessThan(420)
    expect(size.isLarge).toBe(true)
  })
})

describe('ChatImage', () => {
  it('renders a thumbnail carrying the given testId, src and mime', () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" mimeType="image/png" />)
    const img = screen.getByTestId('thumb') as HTMLImageElement
    expect(img.src).toBe(SRC)
    expect(img.getAttribute('data-mime')).toBe('image/png')
    expect(screen.queryByTestId('acp-image-preview-popover')).toBeNull()
  })

  it('opens the preview popover on click and toggles closed on a second click', () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.click(screen.getByTestId('thumb'))
    expect(screen.getByTestId('acp-image-preview-popover')).toBeTruthy()
    fireEvent.click(screen.getByTestId('thumb'))
    expect(screen.queryByTestId('acp-image-preview-popover')).toBeNull()
  })

  it('opens the preview popover on Enter key', () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.keyDown(screen.getByTestId('thumb'), { key: 'Enter' })
    expect(screen.getByTestId('acp-image-preview-popover')).toBeTruthy()
  })

  it('closes the popover on Escape', async () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.click(screen.getByTestId('thumb'))
    // Let the rAF that registers the key listener run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('acp-image-preview-popover')).toBeNull()
  })

  it('closes on Escape even when a global capture-phase handler stops propagation', async () => {
    // Reproduces the real bug: the global keybinding service listens on document
    // in the capture phase and calls stopPropagation() when Escape matches a
    // command, so a bubble-phase listener never sees the event. The popover must
    // still close, which requires it to also listen in the capture phase.
    const swallow = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.stopPropagation()
    }
    document.addEventListener('keydown', swallow, true)
    try {
      render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
      fireEvent.click(screen.getByTestId('thumb'))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByTestId('acp-image-preview-popover')).toBeNull()
    } finally {
      document.removeEventListener('keydown', swallow, true)
    }
  })

  it('closes the popover on outside click', async () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.click(screen.getByTestId('thumb'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('acp-image-preview-popover')).toBeNull()
  })

  it('closes the popover when the close button is clicked', () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.click(screen.getByTestId('thumb'))
    expect(screen.getByTestId('acp-image-preview-popover')).toBeTruthy()
    fireEvent.click(screen.getByTestId('acp-image-preview-close'))
    expect(screen.queryByTestId('acp-image-preview-popover')).toBeNull()
  })

  it('portals the popover to <body> and positions it with fixed viewport coords', () => {
    const { container } = render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.click(screen.getByTestId('thumb'))
    const popover = screen.getByTestId('acp-image-preview-popover')
    // Portaled out of the component subtree so a scroll container can't clip it.
    expect(container.contains(popover)).toBe(false)
    expect(document.body.contains(popover)).toBe(true)
    // JS drives placement in viewport coordinates (position:fixed comes from the
    // CSS module class; left/top/visibility are set inline after measuring).
    expect(popover.style.left).toMatch(/px$/)
    expect(popover.style.top).toMatch(/px$/)
    expect(popover.style.visibility).toBe('visible')
  })

  it('sizes the stage from the thumbnail natural size and window size, anchored (no backdrop) when within range', () => {
    stubWindowSize(1200, 768)
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    const thumb = screen.getByTestId('thumb') as HTMLImageElement
    stubNaturalSize(thumb, 600, 500)
    fireEvent.click(thumb)
    const stage = screen.getByTestId('acp-image-preview-stage')
    expect(stage.style.width).toBe('600px')
    expect(stage.style.height).toBe('500px')
    expect(screen.queryByTestId('acp-image-preview-backdrop')).toBeNull()
    // Anchored mode clamps against the (zero-rect, in jsdom/happy-dom) thumbnail
    // position, landing on the viewport margin rather than centering.
    const popover = screen.getByTestId('acp-image-preview-popover')
    expect(popover.style.left).toBe('8px')
    expect(popover.style.top).toBe('8px')
  })

  it('grows a small image to the min box floor and still anchors without a backdrop', () => {
    stubWindowSize(1200, 768)
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    const thumb = screen.getByTestId('thumb') as HTMLImageElement
    stubNaturalSize(thumb, 40, 40)
    fireEvent.click(thumb)
    const stage = screen.getByTestId('acp-image-preview-stage')
    expect(stage.style.width).toBe('420px')
    expect(stage.style.height).toBe('420px')
    expect(screen.queryByTestId('acp-image-preview-backdrop')).toBeNull()
  })

  it('caps a large image to the max box, shows a backdrop, and centers the popover', () => {
    stubWindowSize(1200, 768)
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    const thumb = screen.getByTestId('thumb') as HTMLImageElement
    stubNaturalSize(thumb, 4000, 3000)
    fireEvent.click(thumb)
    const stage = screen.getByTestId('acp-image-preview-stage')
    // maxWidth = 1200 - 128 = 1072, maxHeight = 768 - 128 = 640; height-bound.
    expect(stage.style.height).toBe('640px')
    expect(screen.getByTestId('acp-image-preview-backdrop')).toBeTruthy()
    const popover = screen.getByTestId('acp-image-preview-popover')
    // Centered mode: left/top land on half the (zero-rect, in happy-dom) viewport.
    expect(popover.style.left).toBe('600px')
    expect(popover.style.top).toBe('384px')
  })

  it('zooms on wheel and resets on double-click', () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.click(screen.getByTestId('thumb'))
    const stage = screen.getByTestId('acp-image-preview-stage')
    const img = stage.querySelector('img') as HTMLImageElement
    fireEvent.wheel(stage, { deltaY: -100, clientX: 10, clientY: 10 })
    expect(img.style.transform).toMatch(/scale\((?!1\))/)
    fireEvent.doubleClick(stage)
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)')
  })
})
