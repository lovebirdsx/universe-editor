import type { MobileMessageImage } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { strings } from '../../strings.js'
import { MessageImages } from '../MessageImages.js'

const image: MobileMessageImage = { index: 0, mimeType: 'image/png', size: 3 }

function makeClient(): { fetchMessageImageBlob: ReturnType<typeof vi.fn> } {
  return {
    fetchMessageImageBlob: vi.fn(async () => new Blob(['abc'], { type: 'image/png' })),
  }
}

describe('MessageImages', () => {
  it('renders nothing without images', () => {
    const { container } = render(<MessageImages messageId="m1" images={[]} client={makeClient()} />)
    expect(container.firstChild).toBeNull()
  })

  it('fetches each image by message id and index, then previews it', async () => {
    const client = makeClient()
    render(<MessageImages messageId="m1" images={[image]} client={client} />)

    await waitFor(() => screen.getByTestId('message-image'))
    expect(client.fetchMessageImageBlob).toHaveBeenCalledWith('m1', 0)
    expect(screen.getByTestId('message-image').querySelector('img')?.src).toMatch(/^blob:/)

    fireEvent.click(screen.getByTestId('message-image'))
    expect(screen.getByTestId('image-preview')).toBeTruthy()
    fireEvent.click(screen.getByTestId('image-preview-close'))
    expect(screen.queryByTestId('image-preview')).toBeNull()
  })

  it('shows an unavailable tile for truncated images without a request', () => {
    const client = makeClient()
    render(
      <MessageImages messageId="m1" images={[{ ...image, truncated: true }]} client={client} />,
    )

    expect(screen.getByTestId('message-image-unavailable').textContent).toContain(
      strings.messageImageUnavailable,
    )
    expect(client.fetchMessageImageBlob).not.toHaveBeenCalled()
  })

  it('reports a load failure', async () => {
    const client = makeClient()
    client.fetchMessageImageBlob.mockRejectedValue(new Error('gone'))
    render(<MessageImages messageId="m1" images={[image]} client={client} />)

    await waitFor(() =>
      expect(screen.getByTestId('message-image-unavailable').textContent).toContain(
        strings.messageImageLoadFailed,
      ),
    )
  })
})
