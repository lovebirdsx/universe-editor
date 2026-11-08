import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strings } from '../../strings.js'
import { FullscreenButton } from '../FullscreenButton.js'

type FullscreenDocument = {
  fullscreenEnabled?: boolean
  fullscreenElement?: Element | null
  exitFullscreen?: unknown
}

const fullscreenDocument = document as unknown as FullscreenDocument

function setFullscreenElement(element: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: element })
}

describe('FullscreenButton', () => {
  let requestFullscreen: ReturnType<typeof vi.fn>
  let exitFullscreen: ReturnType<typeof vi.fn>

  beforeEach(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    setFullscreenElement(null)
    requestFullscreen = vi.fn().mockResolvedValue(undefined)
    exitFullscreen = vi.fn().mockResolvedValue(undefined)
    ;(document.documentElement as unknown as { requestFullscreen: unknown }).requestFullscreen =
      requestFullscreen
    fullscreenDocument.exitFullscreen = exitFullscreen
  })

  afterEach(() => {
    delete fullscreenDocument.fullscreenEnabled
    delete fullscreenDocument.fullscreenElement
    delete fullscreenDocument.exitFullscreen
    delete (document.documentElement as unknown as { requestFullscreen?: unknown })
      .requestFullscreen
  })

  it('renders nothing when the browser cannot go fullscreen', () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false })

    const { container } = render(<FullscreenButton testId="fullscreen-toggle" />)

    expect(container.firstChild).toBeNull()
  })

  it('enters and exits fullscreen', () => {
    const onToggled = vi.fn()
    render(<FullscreenButton testId="fullscreen-toggle" onToggled={onToggled} />)
    const button = screen.getByTestId('fullscreen-toggle')

    expect(button.textContent).toBe(strings.fullscreenEnter)
    fireEvent.click(button)
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' })
    expect(onToggled).toHaveBeenCalledTimes(1)

    act(() => {
      setFullscreenElement(document.documentElement)
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    expect(button.textContent).toBe(strings.fullscreenExit)

    fireEvent.click(button)
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
  })
})
