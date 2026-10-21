/*---------------------------------------------------------------------------------------------
 *  Tests for DialogHost rendering the head of RendererDialogService's queue.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { IConfirmOptions, IConfirmResult } from '@universe-editor/platform'
import { DialogHost } from '../DialogHost.js'
import { RendererDialogService } from '../../../services/dialog/RendererDialogService.js'

afterEach(() => cleanup())

const CANCEL_RESULT: IConfirmResult = {
  confirmed: false,
  choice: 'cancel',
  neverAskAgain: false,
}

function confirmWithCheckboxes(message: string): IConfirmOptions {
  return {
    message,
    neverAskAgainLabel: 'Never ask again',
    checkboxes: [{ label: 'Remember choice' }],
  }
}

describe('RendererDialogService', () => {
  it('confirm primary returns confirmed=true / choice="primary"', async () => {
    const svc = new RendererDialogService()
    render(<DialogHost service={svc} />)
    const promise = svc.confirm({ message: 'Are you sure?' })
    const btn = await screen.findByRole('button', { name: 'OK' })
    fireEvent.click(btn)
    await expect(promise).resolves.toEqual({
      confirmed: true,
      choice: 'primary',
      neverAskAgain: false,
    })
  })

  it('confirm cancel returns confirmed=false / choice="cancel"', async () => {
    const svc = new RendererDialogService()
    render(<DialogHost service={svc} />)
    const promise = svc.confirm({ message: 'Discard?' })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await expect(promise).resolves.toEqual({
      confirmed: false,
      choice: 'cancel',
      neverAskAgain: false,
    })
  })

  it('confirm secondary returns confirmed=false / choice="secondary"', async () => {
    const svc = new RendererDialogService()
    render(<DialogHost service={svc} />)
    const promise = svc.confirm({
      message: 'Save changes?',
      primaryButton: 'Save',
      secondaryButton: "Don't Save",
    })
    fireEvent.click(await screen.findByRole('button', { name: "Don't Save" }))
    await expect(promise).resolves.toEqual({
      confirmed: false,
      choice: 'secondary',
      neverAskAgain: false,
    })
  })

  it('prompt resolves with the input value on OK', async () => {
    const svc = new RendererDialogService()
    render(<DialogHost service={svc} />)
    const promise = svc.prompt({ title: 'File name', initialValue: 'foo.txt' })
    const input = (await screen.findByLabelText('File name')) as HTMLInputElement
    expect(input.value).toBe('foo.txt')
    fireEvent.change(input, { target: { value: 'bar.txt' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await expect(promise).resolves.toBe('bar.txt')
  })

  it('prompt cancel resolves with undefined', async () => {
    const svc = new RendererDialogService()
    render(<DialogHost service={svc} />)
    const promise = svc.prompt({ title: 'File name' })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await expect(promise).resolves.toBeUndefined()
  })

  it('queues multiple dialogs and resolves them in order', async () => {
    const svc = new RendererDialogService()
    render(<DialogHost service={svc} />)
    const first = svc.confirm({ message: 'First?' })
    const second = svc.confirm({ message: 'Second?' })
    expect(await screen.findByText('First?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await first
    // After head resolves, the queue advances
    expect(await screen.findByText('Second?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await second
  })
})

describe('DialogHost dialog identity', () => {
  it('starts a same-kind dialog enqueued in the same tick with fresh checkbox state', async () => {
    const svc = new RendererDialogService()
    render(<DialogHost service={svc} />)

    const first = svc.confirm(confirmWithCheckboxes('First?'))
    const neverAskAgain = (await screen.findByLabelText('Never ask again')) as HTMLInputElement
    const remember = screen.getByLabelText('Remember choice') as HTMLInputElement
    fireEvent.click(neverAskAgain)
    fireEvent.click(remember)
    expect(neverAskAgain.checked).toBe(true)
    expect(remember.checked).toBe(true)

    let second!: Promise<IConfirmResult>
    act(() => {
      // Resolve the head and enqueue its successor in one React batch: the queue
      // length is 1 before and after, so a length-derived key would reuse the old
      // instance and carry its checkbox state into the new dialog.
      svc._resolveEntry(svc.queue[0]!, CANCEL_RESULT)
      second = svc.confirm(confirmWithCheckboxes('Second?'))
    })
    expect(svc.queue).toHaveLength(1)

    expect(await screen.findByText('Second?')).toBeTruthy()
    expect((screen.getByLabelText('Never ask again') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Remember choice') as HTMLInputElement).checked).toBe(false)

    await expect(first).resolves.toEqual(CANCEL_RESULT)
    svc._resolveEntry(svc.queue[0]!, CANCEL_RESULT)
    await expect(second).resolves.toEqual(CANCEL_RESULT)
  })

  it('does not remount the head dialog when another one is queued behind it', async () => {
    const svc = new RendererDialogService()
    const { rerender } = render(<DialogHost service={svc} />)

    const first = svc.confirm(confirmWithCheckboxes('First?'))
    const remember = (await screen.findByLabelText('Remember choice')) as HTMLInputElement
    fireEvent.click(remember)
    expect(remember.checked).toBe(true)

    let second!: Promise<IConfirmResult>
    act(() => {
      second = svc.confirm({ message: 'Second?' })
    })

    // Force a host re-render: a queue-length key changes 1 -> 2 here and remounts
    // the visible dialog, dropping its checked state.
    rerender(<DialogHost service={svc} />)
    expect((screen.getByLabelText('Remember choice') as HTMLInputElement).checked).toBe(true)

    svc._resolveEntry(svc.queue[0]!, CANCEL_RESULT)
    await expect(first).resolves.toEqual(CANCEL_RESULT)
    svc._resolveEntry(svc.queue[0]!, CANCEL_RESULT)
    await expect(second).resolves.toEqual(CANCEL_RESULT)
  })
})
