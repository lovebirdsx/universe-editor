/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ChatImage — the shared 88×88 thumbnail + click-to-open anchored
 *  preview popover used by both the message body and the prompt attachment chips.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatImage } from '../ChatImage.js'

const SRC = 'data:image/png;base64,YWJjZA=='

afterEach(() => {
  cleanup()
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

  it('closes the popover on outside click', async () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.click(screen.getByTestId('thumb'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    fireEvent.mouseDown(document.body)
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

  it('zooms on wheel and resets on double-click', () => {
    render(<ChatImage src={SRC} alt="pic" testId="thumb" />)
    fireEvent.click(screen.getByTestId('thumb'))
    const popover = screen.getByTestId('acp-image-preview-popover')
    const stage = popover.firstChild as HTMLElement
    const img = stage.querySelector('img') as HTMLImageElement
    fireEvent.wheel(stage, { deltaY: -100, clientX: 10, clientY: 10 })
    expect(img.style.transform).toMatch(/scale\((?!1\))/)
    fireEvent.doubleClick(stage)
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)')
  })
})
