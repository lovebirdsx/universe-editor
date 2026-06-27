/*---------------------------------------------------------------------------------------------
 *  Tests for DialogHost rendering the head of RendererDialogService's queue.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DialogHost } from '../DialogHost.js'
import { RendererDialogService } from '../../../services/dialog/RendererDialogService.js'

afterEach(() => cleanup())

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
