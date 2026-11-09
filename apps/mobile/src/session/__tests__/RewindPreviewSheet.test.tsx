import type { MobileRewindPreview } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { commandErrorText, strings } from '../../strings.js'
import { RewindPreviewSheet } from '../RewindPreviewSheet.js'

interface ClientStub {
  readonly previewRewind: ReturnType<typeof vi.fn>
  readonly rewindSession: ReturnType<typeof vi.fn>
}

function createClient(preview: MobileRewindPreview): ClientStub {
  return {
    previewRewind: vi.fn(async () => preview),
    rewindSession: vi.fn(async () => ({ canRewind: true, text: 'original prompt' })),
  }
}

function renderSheet(client: ClientStub) {
  const onClose = vi.fn()
  const onApplied = vi.fn()
  const onNotice = vi.fn()
  render(
    <RewindPreviewSheet
      client={client}
      messageId="msg-1"
      online
      onClose={onClose}
      onApplied={onApplied}
      onNotice={onNotice}
    />,
  )
  return { onClose, onApplied, onNotice }
}

describe('RewindPreviewSheet', () => {
  it('previews the file impact and applies with file discard', async () => {
    const client = createClient({ canRewind: true, filesChanged: 2, insertions: 3, deletions: 1 })
    const { onApplied } = renderSheet(client)

    await waitFor(() =>
      expect(screen.getByTestId('rewind-impact').textContent).toBe(strings.rewindImpact(2, 3, 1)),
    )
    fireEvent.click(screen.getByTestId('rewind-discard'))

    await waitFor(() => expect(client.rewindSession).toHaveBeenCalledWith('msg-1', true))
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith('original prompt'))
  })

  it('applies while keeping file changes', async () => {
    const client = createClient({ canRewind: true, filesChanged: 0 })
    renderSheet(client)

    await waitFor(() =>
      expect(screen.getByTestId('rewind-impact').textContent).toBe('不会改动文件'),
    )
    fireEvent.click(screen.getByTestId('rewind-keep'))

    await waitFor(() => expect(client.rewindSession).toHaveBeenCalledWith('msg-1', false))
  })

  it('shows the agent explanation and no apply buttons when rewind is refused', async () => {
    const client = createClient({ canRewind: false, error: 'no checkpoint', filesChanged: 0 })
    renderSheet(client)

    await waitFor(() =>
      expect(screen.getByTestId('rewind-error').textContent).toBe('no checkpoint'),
    )
    expect(screen.queryByTestId('rewind-discard')).toBeNull()
    expect(screen.queryByTestId('rewind-keep')).toBeNull()
    expect(screen.getByTestId('rewind-cancel')).toBeTruthy()
  })

  it('surfaces a preview failure', async () => {
    const client = createClient({ canRewind: true, filesChanged: 0 })
    client.previewRewind.mockRejectedValueOnce(
      Object.assign(new Error('bad'), { code: 'invalid_anchor' }),
    )
    renderSheet(client)

    await waitFor(() =>
      expect(screen.getByTestId('rewind-error').textContent).toBe(
        commandErrorText('invalid_anchor'),
      ),
    )
  })

  it('keeps the sheet open and reports an apply failure', async () => {
    const client = createClient({ canRewind: true, filesChanged: 1 })
    client.rewindSession.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'session_read_only' }),
    )
    const { onNotice, onClose } = renderSheet(client)

    await waitFor(() => expect(screen.getByTestId('rewind-keep')).toBeTruthy())
    fireEvent.click(screen.getByTestId('rewind-keep'))

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(commandErrorText('session_read_only')),
    )
    expect(onClose).not.toHaveBeenCalled()
  })
})
