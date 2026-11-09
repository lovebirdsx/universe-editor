import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strings } from '../../strings.js'
import { Composer, draftKey } from '../Composer.js'

beforeEach(() => {
  sessionStorage.clear()
})

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async () => undefined)
  const onStop = vi.fn(async () => undefined)
  const onUploadAttachment = vi.fn(async () => ({
    id: 'att-1',
    kind: 'image' as const,
    name: 'shot.png',
    mimeType: 'image/png',
    size: 3,
    createdAt: 1,
  }))
  const onNotice = vi.fn()
  const props = {
    sessionKey: '1:s1',
    readOnly: false,
    running: false,
    online: true,
    imageSupported: true,
    fileSupported: true,
    onUploadAttachment,
    onSend,
    onStop,
    onNotice,
    ...overrides,
  }
  render(<Composer {...props} />)
  return { onSend, onStop, onUploadAttachment, onNotice }
}

describe('Composer', () => {
  it('sends a typed prompt and clears the draft', async () => {
    const { onSend } = renderComposer()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'hello phone' } })

    const send = screen.getByTestId('composer-send')
    fireEvent.click(send)

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello phone', []))
    await waitFor(() => expect(input.value).toBe(''))
    expect(sessionStorage.getItem(draftKey('1:s1'))).toBeNull()
  })

  it('shows stop while running and still allows a queued send', async () => {
    const { onStop } = renderComposer({ running: true })
    expect(screen.getByTestId('composer-stop')).toBeTruthy()
    expect(screen.queryByTestId('composer-send')).toBeNull()

    fireEvent.click(screen.getByTestId('composer-stop'))
    await waitFor(() => expect(onStop).toHaveBeenCalled())

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'steer' } })
    expect(screen.getByTestId('composer-send')).toBeTruthy()
  })

  it('disables input and send for a read-only session', () => {
    renderComposer({ readOnly: true })
    expect(screen.getByText(strings.composerReadOnly)).toBeTruthy()
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('disables input and explains the PC is offline', () => {
    renderComposer({ online: false })
    expect(screen.getByText(strings.composerOffline)).toBeTruthy()
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('uploads a picked photo and sends it without text', async () => {
    const { onSend, onUploadAttachment } = renderComposer()
    const input = screen.getByTestId('composer-photo-input')
    fireEvent.change(input, {
      target: { files: [new File(['abc'], 'shot.png', { type: 'image/png' })] },
    })

    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledWith(expect.any(File), 'image'))
    const send = screen.getByTestId('composer-send') as HTMLButtonElement
    await waitFor(() => expect(send.disabled).toBe(false))
    fireEvent.click(send)
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', ['att-1']))
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('treats images chosen through the file picker as file attachments', async () => {
    const { onUploadAttachment } = renderComposer()
    const input = screen.getByTestId('composer-file-input')
    fireEvent.change(input, {
      target: { files: [new File(['abc'], 'shot.png', { type: 'image/png' })] },
    })

    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledWith(expect.any(File), 'file'))
  })

  it('keeps a failed upload visible and blocks sending until it is removed', async () => {
    const onUploadAttachment = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'network' })
    })
    const { onNotice } = renderComposer({ onUploadAttachment })
    const input = screen.getByTestId('composer-file-input')
    fireEvent.change(input, {
      target: { files: [new File(['abc'], 'notes.txt', { type: 'text/plain' })] },
    })

    await waitFor(() => expect(screen.getByText(strings.attachmentUploadFailed)).toBeTruthy())
    expect(onNotice).toHaveBeenCalledTimes(1)
    expect((screen.getByTestId('composer-send') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByLabelText(strings.attachmentRemove))
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('hides the attachment entry when neither capability is available', () => {
    renderComposer({ imageSupported: false, fileSupported: false })
    expect(screen.queryByTestId('composer-attach')).toBeNull()
    expect(screen.queryByTestId('composer-photo-input')).toBeNull()
    expect(screen.queryByTestId('composer-file-input')).toBeNull()
  })

  it('offers only the file entry for agents without image support', () => {
    renderComposer({ imageSupported: false })
    expect(screen.queryByTestId('composer-photo-input')).toBeNull()
    expect(screen.getByTestId('composer-file-input')).toBeTruthy()

    fireEvent.click(screen.getByTestId('composer-attach'))
    expect(screen.queryByTestId('attachment-camera')).toBeNull()
    expect(screen.queryByTestId('attachment-photos')).toBeNull()
    expect(screen.getByTestId('attachment-files')).toBeTruthy()
  })

  it('restores and saves the per-session draft', () => {
    sessionStorage.setItem(draftKey('1:s1'), 'unfinished')
    renderComposer()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    expect(input.value).toBe('unfinished')

    fireEvent.change(input, { target: { value: 'updated' } })
    expect(sessionStorage.getItem(draftKey('1:s1'))).toBe('updated')
    expect(sessionStorage.getItem(draftKey('2:s2'))).toBeNull()
  })

  it('applies a backfill over the stored draft and refocuses the input', () => {
    sessionStorage.setItem(draftKey('1:s1'), 'old draft')
    renderComposer({ prefill: { token: 1, sessionKey: '1:s1', text: '> quoted\n\n' } })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

    expect(input.value).toBe('> quoted\n\n')
    expect(document.activeElement).toBe(input)
    expect(sessionStorage.getItem(draftKey('1:s1'))).toBe('> quoted\n\n')
  })

  it('ignores a backfill that belongs to another session', () => {
    sessionStorage.setItem(draftKey('1:s1'), 'old draft')
    renderComposer({ prefill: { token: 1, sessionKey: '2:s2', text: 'leaked prompt' } })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

    expect(input.value).toBe('old draft')
    expect(sessionStorage.getItem(draftKey('1:s1'))).toBe('old draft')
  })

  it('reapplies the same text when the token changes', () => {
    const { rerender } = renderPrefillComposer()

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    expect(input.value).toBe('original prompt')

    fireEvent.change(input, { target: { value: 'edited' } })
    rerender(
      <Composer
        {...composerProps({ prefill: { token: 2, sessionKey: '1:s1', text: 'original prompt' } })}
      />,
    )
    expect(input.value).toBe('original prompt')
  })
})

function composerProps(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  return {
    sessionKey: '1:s1',
    readOnly: false,
    running: false,
    online: true,
    imageSupported: true,
    fileSupported: true,
    onUploadAttachment: vi.fn(async () => ({
      id: 'att-1',
      kind: 'image' as const,
      name: 'shot.png',
      mimeType: 'image/png',
      size: 3,
      createdAt: 1,
    })),
    onSend: vi.fn(async () => undefined),
    onStop: vi.fn(async () => undefined),
    onNotice: vi.fn(),
    ...overrides,
  }
}

function renderPrefillComposer() {
  const props = composerProps({
    prefill: { token: 1, sessionKey: '1:s1', text: 'original prompt' },
  })
  const { rerender } = render(<Composer {...props} />)
  return { rerender }
}
