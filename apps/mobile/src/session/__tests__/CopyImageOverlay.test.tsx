import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeClipboardImage } from '../../clipboard.js'
import { strings } from '../../strings.js'
import { CopyImageOverlay } from '../CopyImageOverlay.js'

vi.mock('../../clipboard.js', () => ({ writeClipboardImage: vi.fn() }))

const writeClipboardImageMock = vi.mocked(writeClipboardImage)
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share')
const originalCanShare = Object.getOwnPropertyDescriptor(navigator, 'canShare')
const createObjectURL = vi.fn(() => 'blob:message')
const revokeObjectURL = vi.fn()

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) delete (target as Record<string, unknown>)[key]
  else Object.defineProperty(target, key, descriptor)
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  writeClipboardImageMock.mockReset()
  writeClipboardImageMock.mockResolvedValue(true)
})

afterEach(() => {
  restoreProperty(URL, 'createObjectURL', originalCreateObjectURL)
  restoreProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  restoreProperty(navigator, 'share', originalShare)
  restoreProperty(navigator, 'canShare', originalCanShare)
})

function renderOverlay(): {
  readonly blob: Blob
  readonly onClose: ReturnType<typeof vi.fn>
  readonly onCopied: ReturnType<typeof vi.fn>
  readonly unmount: () => void
} {
  const blob = new Blob(['png'], { type: 'image/png' })
  const onClose = vi.fn()
  const onCopied = vi.fn()
  const { unmount } = render(<CopyImageOverlay blob={blob} onClose={onClose} onCopied={onCopied} />)
  return { blob, onClose, onCopied, unmount }
}

describe('CopyImageOverlay', () => {
  it('shows the captured image, hint and actions', () => {
    renderOverlay()

    expect(screen.getByTestId('copy-image-preview')).toBeTruthy()
    expect(screen.getByTestId('copy-image-preview-image').getAttribute('src')).toBe('blob:message')
    expect(screen.getByText(strings.copyImagePreviewHint)).toBeTruthy()
    expect(screen.getByTestId('copy-image-preview-copy')).toBeTruthy()
    expect(screen.getByTestId('copy-image-preview-save').getAttribute('download')).toBe(
      'message.png',
    )
    expect(screen.queryByTestId('copy-image-preview-share')).toBeNull()
  })

  it('closes from the button and the Escape key', () => {
    const { onClose, unmount } = renderOverlay()
    fireEvent.click(screen.getByTestId('copy-image-preview-close'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('retries the clipboard write and reports success', async () => {
    const { blob, onCopied } = renderOverlay()

    fireEvent.click(screen.getByTestId('copy-image-preview-copy'))

    await waitFor(() => expect(onCopied).toHaveBeenCalledTimes(1))
    expect(writeClipboardImageMock).toHaveBeenCalledWith(blob)
  })

  it('keeps the overlay open with an inline error when copying fails', async () => {
    writeClipboardImageMock.mockResolvedValue(false)
    const { onCopied } = renderOverlay()

    fireEvent.click(screen.getByTestId('copy-image-preview-copy'))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(strings.copyImagePreviewCopyFailed),
    )
    expect(onCopied).not.toHaveBeenCalled()
    expect(screen.getByTestId('copy-image-preview')).toBeTruthy()
  })

  it('offers sharing only when files are shareable and passes the PNG', async () => {
    const share = vi.fn(async (_data?: ShareData) => undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: vi.fn(() => true),
    })
    renderOverlay()

    fireEvent.click(screen.getByTestId('copy-image-preview-share'))

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    const data = share.mock.calls[0]?.[0] as ShareData
    expect(data.title).toBe(strings.copyImagePreviewTitle)
    expect(data.files?.[0]?.name).toBe('message.png')
    expect(data.files?.[0]?.type).toBe('image/png')
  })

  it('releases the object URL on unmount', () => {
    const { unmount } = renderOverlay()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:message')
  })
})
