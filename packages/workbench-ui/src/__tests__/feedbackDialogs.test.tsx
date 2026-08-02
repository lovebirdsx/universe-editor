/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the presentational ProgressDialog / ConfirmDialog / PromptDialog.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ProgressDialog } from '../feedback/progress/ProgressDialog.js'
import { ConfirmDialog, PromptDialog } from '../feedback/dialog/Dialogs.js'

afterEach(() => cleanup())

describe('ProgressDialog', () => {
  it('renders an indeterminate bar and no cancel button by default', () => {
    render(
      <ProgressDialog
        state={{
          title: 'Working',
          message: undefined,
          percent: undefined,
          cancellable: false,
          cancel: () => {},
        }}
      />,
    )
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.queryByTestId('progress-dialog-cancel')).toBeNull()
  })

  it('renders cancel button and fires cancel', () => {
    const cancel = vi.fn()
    render(
      <ProgressDialog
        state={{ title: 'T', message: 'msg', percent: 40, cancellable: true, cancel }}
      />,
    )
    expect(screen.getByText('msg')).toBeTruthy()
    fireEvent.click(screen.getByTestId('progress-dialog-cancel'))
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('ConfirmDialog', () => {
  it('primary click resolves primary', () => {
    const onResolve = vi.fn()
    render(<ConfirmDialog opts={{ message: 'Sure?' }} onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onResolve).toHaveBeenCalledWith({
      confirmed: true,
      choice: 'primary',
      neverAskAgain: false,
    })
  })

  it('secondary button resolves secondary', () => {
    const onResolve = vi.fn()
    render(
      <ConfirmDialog
        opts={{ message: 'Save?', primaryButton: 'Save', secondaryButton: "Don't Save" }}
        onResolve={onResolve}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: "Don't Save" }))
    expect(onResolve).toHaveBeenCalledWith({
      confirmed: false,
      choice: 'secondary',
      neverAskAgain: false,
    })
  })

  it('focuses the primary button on mount so Enter confirms over a focus trap', () => {
    const onResolve = vi.fn()
    render(
      <ConfirmDialog
        opts={{ message: 'Create it?', primaryButton: 'Create' }}
        onResolve={onResolve}
      />,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create' }))
  })

  it('does not render a checkbox row without opts.checkboxes, and omits checkboxChecked', () => {
    const onResolve = vi.fn()
    render(<ConfirmDialog opts={{ message: 'Sure?' }} onResolve={onResolve} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onResolve).toHaveBeenCalledWith({
      confirmed: true,
      choice: 'primary',
      neverAskAgain: false,
    })
  })

  it('renders the generic checkbox with its initial state and echoes the toggled value', () => {
    const onResolve = vi.fn()
    render(
      <ConfirmDialog
        opts={{
          message: 'Apply?',
          checkboxes: [{ label: 'Include outside', initiallyChecked: true }],
        }}
        onResolve={onResolve}
      />,
    )
    const checkbox = screen.getByRole('checkbox', { name: 'Include outside' })
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onResolve).toHaveBeenCalledWith({
      confirmed: true,
      choice: 'primary',
      neverAskAgain: false,
      checkboxChecked: [false],
    })
  })

  it('echoes the checkbox state on cancel too', () => {
    const onResolve = vi.fn()
    render(
      <ConfirmDialog
        opts={{ message: 'Apply?', checkboxes: [{ label: 'Include outside' }] }}
        onResolve={onResolve}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include outside' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onResolve).toHaveBeenCalledWith({
      confirmed: false,
      choice: 'cancel',
      neverAskAgain: false,
      checkboxChecked: [true],
    })
  })

  it('coexists with the never-ask-again row as a second checkbox', () => {
    render(
      <ConfirmDialog
        opts={{
          message: 'Sure?',
          neverAskAgainLabel: "Don't ask again",
          checkboxes: [{ label: 'Include outside' }],
        }}
        onResolve={vi.fn()}
      />,
    )
    expect(screen.getByRole('checkbox', { name: "Don't ask again" })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Include outside' })).toBeTruthy()
  })

  it('toggles multiple checkboxes independently and echoes them in order', () => {
    const onResolve = vi.fn()
    render(
      <ConfirmDialog
        opts={{
          message: 'Apply?',
          checkboxes: [
            { label: 'Include outside', initiallyChecked: true },
            { label: 'Open in changelist', initiallyChecked: true },
          ],
        }}
        onResolve={onResolve}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open in changelist' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onResolve).toHaveBeenCalledWith({
      confirmed: true,
      choice: 'primary',
      neverAskAgain: false,
      checkboxChecked: [true, false],
    })
  })

  it('renders no checkbox row for an empty checkboxes array', () => {
    const onResolve = vi.fn()
    render(<ConfirmDialog opts={{ message: 'Sure?', checkboxes: [] }} onResolve={onResolve} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onResolve).toHaveBeenCalledWith({
      confirmed: true,
      choice: 'primary',
      neverAskAgain: false,
    })
  })
})

describe('PromptDialog', () => {
  it('OK resolves with the input value', () => {
    const onResolve = vi.fn()
    render(<PromptDialog opts={{ title: 'Name', initialValue: 'foo' }} onResolve={onResolve} />)
    const input = screen.getByLabelText('Name') as HTMLInputElement
    expect(input.value).toBe('foo')
    fireEvent.change(input, { target: { value: 'bar' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onResolve).toHaveBeenCalledWith('bar')
  })

  it('Cancel resolves undefined', () => {
    const onResolve = vi.fn()
    render(<PromptDialog opts={{ title: 'Name' }} onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onResolve).toHaveBeenCalledWith(undefined)
  })
})
