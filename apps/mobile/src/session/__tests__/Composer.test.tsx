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
    commands: [],
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
    const input = screen.getByTestId('composer-attachment-input')
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

  it('treats photos as ordinary files when the agent has no image support', async () => {
    const { onUploadAttachment } = renderComposer({ imageSupported: false })
    const input = screen.getByTestId('composer-attachment-input')
    fireEvent.change(input, {
      target: { files: [new File(['abc'], 'shot.png', { type: 'image/png' })] },
    })

    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledWith(expect.any(File), 'file'))
  })

  it('limits remote sessions to images and rejects other files', () => {
    const { onUploadAttachment, onNotice } = renderComposer({ fileSupported: false })
    const input = screen.getByTestId('composer-attachment-input') as HTMLInputElement
    expect(input.accept).toBe('image/*')

    fireEvent.change(input, {
      target: { files: [new File(['abc'], 'notes.txt', { type: 'text/plain' })] },
    })
    expect(onNotice).toHaveBeenCalledWith(strings.attachmentUnsupportedImage)
    expect(onUploadAttachment).not.toHaveBeenCalled()
  })

  it('keeps a failed upload visible and blocks sending until it is removed', async () => {
    const onUploadAttachment = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'network' })
    })
    const { onNotice } = renderComposer({ onUploadAttachment })
    const input = screen.getByTestId('composer-attachment-input')
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
    expect(screen.queryByTestId('composer-attachment-input')).toBeNull()
  })

  it('opens the system picker directly from the attach button', () => {
    renderComposer()
    const input = screen.getByTestId('composer-attachment-input') as HTMLInputElement
    expect(input.hasAttribute('accept')).toBe(false)
    expect(input.multiple).toBe(true)

    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByTestId('composer-attach'))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('auto-grows with the content and shrinks back', () => {
    renderComposer()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 400 })
    fireEvent.change(input, { target: { value: 'one\ntwo\nthree\nfour\nfive\nsix' } })
    expect(input.style.height).toBe('132px')

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 60 })
    fireEvent.change(input, { target: { value: 'one' } })
    expect(input.style.height).toBe('60px')
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

  describe('slash commands', () => {
    const commands = [
      { name: 'diff', description: 'Review the working tree', inputHint: 'path' },
      { name: 'compact', description: 'Compact the conversation' },
    ]

    const type = (input: HTMLTextAreaElement, value: string): void => {
      fireEvent.change(input, { target: { value } })
    }

    it('opens on / and filters as the user types', () => {
      renderComposer({ commands })
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      fireEvent.focus(input)

      type(input, '/')
      expect(screen.getAllByTestId('composer-command-option')).toHaveLength(2)

      type(input, '/co')
      const options = screen.getAllByTestId('composer-command-option')
      expect(options).toHaveLength(1)
      expect(options[0]?.textContent).toContain('/compact')
    })

    it('does not open when the agent advertises no commands', () => {
      renderComposer()
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      fireEvent.focus(input)

      type(input, '/')
      expect(screen.queryByTestId('composer-command-panel')).toBeNull()
      expect(screen.queryByTestId('composer-slash')).toBeNull()
    })

    it('inserts the picked command and leaves the caret ready for arguments', async () => {
      renderComposer({ commands })
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      fireEvent.focus(input)
      type(input, '/di')

      fireEvent.click(screen.getAllByTestId('composer-command-option')[0]!)

      await waitFor(() => expect(input.value).toBe('/diff '))
      expect(input.selectionStart).toBe(6)
      expect(screen.queryByTestId('composer-command-panel')).toBeNull()
      expect(document.activeElement).toBe(input)
    })

    it('closes once the caret leaves the command token', () => {
      renderComposer({ commands })
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      fireEvent.focus(input)
      type(input, '/diff hello')

      expect(screen.queryByTestId('composer-command-panel')).toBeNull()
    })

    it('supports arrow keys, Enter and Escape', async () => {
      renderComposer({ commands })
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      fireEvent.focus(input)
      type(input, '/')

      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(input.value).toBe('/compact '))

      type(input, '/')
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByTestId('composer-command-panel')).toBeNull()
    })

    it('offers the slash shortcut only for an empty composer', () => {
      renderComposer({ commands })
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      expect(screen.getByTestId('composer-slash')).toBeTruthy()

      fireEvent.click(screen.getByTestId('composer-slash'))
      expect(input.value).toBe('/')
      expect(screen.getByTestId('composer-command-panel')).toBeTruthy()

      type(input, '/di')
      expect(screen.queryByTestId('composer-slash')).toBeNull()
    })

    it('does not pop the list for a restored draft until the user edits', () => {
      sessionStorage.setItem(draftKey('1:s1'), '/diff')
      renderComposer({ commands })
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      fireEvent.focus(input)
      expect(screen.queryByTestId('composer-command-panel')).toBeNull()

      type(input, '/diff ')
      expect(screen.queryByTestId('composer-command-panel')).toBeNull()
      type(input, '/dif')
      expect(screen.getByTestId('composer-command-panel')).toBeTruthy()
    })
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
    commands: [],
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
