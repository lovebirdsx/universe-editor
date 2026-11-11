import type { MobileAttachmentUploadResult } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strings } from '../../strings.js'
import { Composer, draftKey, legacyDraftKey, readDraft, writeDraft } from '../Composer.js'

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
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
  const onDraftChange = vi.fn()
  const props = {
    sessionKey: '1:s1',
    readOnly: false,
    running: false,
    online: true,
    imageSupported: true,
    fileSupported: true,
    commands: [],
    onUploadAttachment,
    fetchDraftImage: vi.fn(async () => new Blob()),
    onDraftChange,
    onSend,
    onStop,
    onNotice,
    ...overrides,
  }
  const view = render(<Composer {...props} />)
  return {
    onSend,
    onStop,
    onUploadAttachment,
    onNotice,
    onDraftChange,
    unmount: view.unmount,
  }
}

function pickFile(name: string, type: string): void {
  fireEvent.change(screen.getByTestId('composer-attachment-input'), {
    target: { files: [new File(['abc'], name, { type })] },
  })
}

async function previewSrc(): Promise<string> {
  const button = await waitFor(() => screen.getByTestId('composer-attachment-image-button'))
  return button.querySelector('img')?.getAttribute('src') ?? ''
}

describe('Composer', () => {
  it('sends a typed prompt and clears the draft', async () => {
    const { onSend } = renderComposer()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'hello phone' } })

    const send = screen.getByTestId('composer-send')
    fireEvent.click(send)

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello phone', [], [], []))
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
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', ['att-1'], [], []))
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

  it('opens and closes the full-screen preview from an image thumbnail', async () => {
    renderComposer()
    pickFile('shot.png', 'image/png')

    const src = await previewSrc()
    expect(src).toMatch(/^blob:/)
    const button = screen.getByTestId('composer-attachment-image-button')
    expect(button.getAttribute('aria-label')).toBe(strings.imagePreviewOpen('shot.png'))

    fireEvent.click(button)
    expect(screen.getByTestId('image-preview')).toBeTruthy()
    expect(screen.getByTestId('image-preview-image').getAttribute('src')).toBe(src)
    expect(document.documentElement.classList.contains('is-scroll-locked')).toBe(true)

    fireEvent.click(screen.getByTestId('image-preview-close'))
    expect(screen.queryByTestId('image-preview')).toBeNull()
    expect(document.documentElement.classList.contains('is-scroll-locked')).toBe(false)
  })

  it('does not make file attachments previewable', async () => {
    renderComposer()
    pickFile('notes.txt', 'text/plain')

    const chip = await waitFor(() => screen.getByTestId('composer-attachment-file'))
    expect(within(chip).queryByTestId('composer-attachment-image-button')).toBeNull()
  })

  it('previews an image while its upload is still pending', async () => {
    const onUploadAttachment = vi.fn(
      () => new Promise<MobileAttachmentUploadResult>(() => undefined),
    )
    renderComposer({ onUploadAttachment })
    pickFile('shot.png', 'image/png')

    const chip = await waitFor(() => screen.getByTestId('composer-attachment-image'))
    expect(chip.className).toContain('composer__chip--uploading')
    fireEvent.click(screen.getByTestId('composer-attachment-image-button'))
    expect(screen.getByTestId('image-preview')).toBeTruthy()
  })

  it('previews an image after its upload failed', async () => {
    const onUploadAttachment = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'network' })
    })
    renderComposer({ onUploadAttachment })
    pickFile('shot.png', 'image/png')

    await waitFor(() => expect(screen.getByText(strings.attachmentUploadFailed)).toBeTruthy())
    fireEvent.click(screen.getByTestId('composer-attachment-image-button'))
    expect(screen.getByTestId('image-preview')).toBeTruthy()
  })

  it('revokes the local preview URL when the attachment is removed', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    renderComposer()
    pickFile('shot.png', 'image/png')
    const src = await previewSrc()
    await waitFor(() =>
      expect(screen.getByTestId('composer-attachment-image').className).toContain(
        'composer__chip--uploaded',
      ),
    )

    fireEvent.click(screen.getByLabelText(strings.attachmentRemove))
    expect(revoke).toHaveBeenCalledWith(src)
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('revokes local preview URLs after a successful send', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const { onSend } = renderComposer()
    pickFile('shot.png', 'image/png')
    const src = await previewSrc()

    const send = screen.getByTestId('composer-send') as HTMLButtonElement
    await waitFor(() => expect(send.disabled).toBe(false))
    fireEvent.click(send)

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', ['att-1'], [], []))
    expect(revoke).toHaveBeenCalledWith(src)
  })

  it('revokes local preview URLs on unmount', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const { unmount } = renderComposer()
    pickFile('shot.png', 'image/png')
    const src = await previewSrc()
    unmount()

    expect(revoke).toHaveBeenCalledWith(src)
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
    sessionStorage.setItem(legacyDraftKey('1:s1'), 'unfinished')
    renderComposer()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    expect(input.value).toBe('unfinished')

    fireEvent.change(input, { target: { value: 'updated' } })
    expect(readDraft('1:s1').text).toBe('updated')
    expect(sessionStorage.getItem(draftKey('2:s2'))).toBeNull()
  })

  it('migrates a legacy per-session draft into the v2 store', () => {
    sessionStorage.setItem(legacyDraftKey('1:s1'), 'legacy text')
    renderComposer()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

    expect(input.value).toBe('legacy text')
    expect(sessionStorage.getItem(legacyDraftKey('1:s1'))).toBeNull()
    expect(readDraft('1:s1').text).toBe('legacy text')
  })

  it('prunes the least recently written drafts beyond the storage cap', () => {
    for (let index = 0; index < 20; index += 1) {
      writeDraft(`sk-${index}`, `text ${index}`, 0, index)
    }
    writeDraft('sk-new', 'fresh', 0, 100)

    expect(sessionStorage.getItem(draftKey('sk-0'))).toBeNull()
    expect(readDraft('sk-1').text).toBe('text 1')
    expect(readDraft('sk-new').text).toBe('fresh')
  })

  it('applies a backfill over the stored draft and refocuses the input', () => {
    sessionStorage.setItem(legacyDraftKey('1:s1'), 'old draft')
    renderComposer({ prefill: { token: 1, sessionKey: '1:s1', text: '> quoted\n\n' } })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

    expect(input.value).toBe('> quoted\n\n')
    expect(document.activeElement).toBe(input)
    expect(readDraft('1:s1').text).toBe('> quoted\n\n')
  })

  it('ignores a backfill that belongs to another session', () => {
    sessionStorage.setItem(legacyDraftKey('1:s1'), 'old draft')
    renderComposer({ prefill: { token: 1, sessionKey: '2:s2', text: 'leaked prompt' } })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

    expect(input.value).toBe('old draft')
    expect(readDraft('1:s1').text).toBe('old draft')
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
      sessionStorage.setItem(legacyDraftKey('1:s1'), '/diff')
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

  describe('draft sync', () => {
    const remote = (revision: number, text: string) => ({
      text,
      images: [],
      revision,
      updatedAt: revision,
      source: 'pc' as const,
    })
    const draftImage = {
      id: 'img-1',
      source: 'pc' as const,
      mimeType: 'image/png',
      byteSize: 3,
      name: 'shot.png',
    }

    it('applies a remote draft without publishing it back', async () => {
      const onDraftChange = vi.fn()
      render(<Composer {...composerProps({ draft: remote(4, 'from pc'), onDraftChange })} />)
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

      await waitFor(() => expect(input.value).toBe('from pc'))
      expect(onDraftChange).not.toHaveBeenCalled()
    })

    it('publishes a local edit after the debounce without remote fields', async () => {
      const onDraftChange = vi.fn()
      render(<Composer {...composerProps({ draft: remote(4, 'from pc'), onDraftChange })} />)
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe('from pc'))

      fireEvent.change(input, { target: { value: 'typed here' } })

      await waitFor(() => expect(onDraftChange.mock.calls[0]?.[0]).toBe('typed here'))
      expect(onDraftChange.mock.calls[0]?.[1]).toEqual([])
      expect(onDraftChange.mock.calls[0]?.[2]).toEqual([])
    })

    it('publishes an empty draft when the user deletes everything', async () => {
      let seq = 0
      const onDraftChange = vi.fn<(text: string) => string>(() => `u${(seq += 1)}`)
      render(<Composer {...composerProps({ onDraftChange })} />)
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

      fireEvent.change(input, { target: { value: 'abc' } })
      await waitFor(() => expect(onDraftChange).toHaveBeenCalled())
      onDraftChange.mockClear()

      fireEvent.change(input, { target: { value: '' } })
      await waitFor(() => expect(onDraftChange.mock.calls[0]?.[0]).toBe(''))
    })

    it('does not publish or move the caret when the user moves the selection', async () => {
      const onDraftChange = vi.fn()
      render(<Composer {...composerProps({ draft: remote(4, 'hello'), onDraftChange })} />)
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe('hello'))

      input.focus()
      input.setSelectionRange(2, 2)
      fireEvent.select(input)
      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(input.selectionStart).toBe(2)
      expect(onDraftChange).not.toHaveBeenCalled()
    })

    it('keeps the local selection when remote text is applied', async () => {
      const onDraftChange = vi.fn()
      const { rerender } = render(
        <Composer {...composerProps({ draft: remote(1, 'abcdef'), onDraftChange })} />,
      )
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe('abcdef'))

      input.focus()
      input.setSelectionRange(2, 2)
      rerender(<Composer {...composerProps({ draft: remote(2, 'abcdefghij'), onDraftChange })} />)

      await waitFor(() => expect(input.value).toBe('abcdefghij'))
      expect(input.selectionStart).toBe(2)
      expect(onDraftChange).not.toHaveBeenCalled()
    })

    it('places the caret at the end when remote text fills an empty composer', async () => {
      const { rerender } = render(<Composer {...composerProps()} />)
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

      rerender(<Composer {...composerProps({ draft: remote(1, 'remote text') })} />)

      await waitFor(() => expect(input.value).toBe('remote text'))
      expect(input.selectionStart).toBe('remote text'.length)
    })

    it('defers remote text until the local publish is acknowledged', async () => {
      const onDraftChange = vi.fn(() => 'u1')
      const { rerender } = render(<Composer {...composerProps({ onDraftChange })} />)
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      fireEvent.change(input, { target: { value: 'mine' } })
      await waitFor(() => expect(onDraftChange).toHaveBeenCalledTimes(1))

      rerender(<Composer {...composerProps({ draft: remote(5, 'theirs'), onDraftChange })} />)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(input.value).toBe('mine')

      rerender(
        <Composer
          {...composerProps({
            draft: remote(5, 'theirs'),
            draftAck: { clientUpdateId: 'u1', revision: 4 },
            onDraftChange,
          })}
        />,
      )

      await waitFor(() => expect(input.value).toBe('theirs'))
      expect(onDraftChange).toHaveBeenCalledTimes(1)
    })

    it('applies remote text even when the remote attachment list changed', async () => {
      const onDraftChange = vi.fn()
      const { rerender } = render(
        <Composer
          {...composerProps({ draft: { ...remote(4, 'a'), images: [draftImage] }, onDraftChange })}
        />,
      )
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe('a'))

      rerender(
        <Composer
          {...composerProps({
            draft: { ...remote(5, 'b'), images: [draftImage, { ...draftImage, id: 'img-2' }] },
            onDraftChange,
          })}
        />,
      )

      await waitFor(() => expect(input.value).toBe('b'))
      expect(onDraftChange).not.toHaveBeenCalled()
    })

    it('waits for composition to end before applying remote text', async () => {
      const onDraftChange = vi.fn()
      const { rerender } = render(<Composer {...composerProps({ onDraftChange })} />)
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement

      fireEvent.compositionStart(input)
      rerender(<Composer {...composerProps({ draft: remote(3, '组合词'), onDraftChange })} />)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(input.value).toBe('')

      fireEvent.compositionEnd(input)
      await waitFor(() => expect(input.value).toBe('组合词'))
    })

    it('renders a PC draft picture and can withdraw it', async () => {
      const onDraftChange = vi.fn()
      const draft = { ...remote(4, ''), images: [draftImage] }
      render(<Composer {...composerProps({ draft, onDraftChange })} />)

      expect(screen.getByTestId('composer-draft-images')).toBeTruthy()
      fireEvent.click(screen.getByLabelText(strings.draftImageRemove))

      await waitFor(() => expect(onDraftChange.mock.calls[0]?.[1]).toEqual([]))
    })

    it('shows a draft file from another phone and can withdraw it', async () => {
      const onDraftChange = vi.fn()
      const draft = {
        ...remote(4, ''),
        files: [{ id: 'file-1', name: 'notes.txt', mimeType: 'text/plain', byteSize: 7 }],
      }
      render(<Composer {...composerProps({ draft, onDraftChange })} />)

      expect(screen.getByTestId('composer-draft-files')).toBeTruthy()
      fireEvent.click(screen.getByLabelText(strings.attachmentRemove))

      await waitFor(() => expect(onDraftChange.mock.calls[0]?.[2]).toEqual([]))
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
    fetchDraftImage: vi.fn(async () => new Blob()),
    onSend: vi.fn(async () => undefined),
    onStop: vi.fn(async () => undefined),
    onDraftChange: vi.fn(),
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
