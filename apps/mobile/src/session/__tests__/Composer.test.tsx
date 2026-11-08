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
  const onNotice = vi.fn()
  const props = {
    sessionKey: '1:s1',
    readOnly: false,
    running: false,
    online: true,
    onSend,
    onStop,
    onNotice,
    ...overrides,
  }
  render(<Composer {...props} />)
  return { onSend, onStop, onNotice }
}

describe('Composer', () => {
  it('sends a typed prompt and clears the draft', async () => {
    const { onSend } = renderComposer()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'hello phone' } })

    const send = screen.getByTestId('composer-send')
    fireEvent.click(send)

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello phone'))
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

  it('restores and saves the per-session draft', () => {
    sessionStorage.setItem(draftKey('1:s1'), 'unfinished')
    renderComposer()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    expect(input.value).toBe('unfinished')

    fireEvent.change(input, { target: { value: 'updated' } })
    expect(sessionStorage.getItem(draftKey('1:s1'))).toBe('updated')
    expect(sessionStorage.getItem(draftKey('2:s2'))).toBeNull()
  })
})
