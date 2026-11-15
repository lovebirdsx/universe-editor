/*---------------------------------------------------------------------------------------------
 *  FormField / FormSection / ModalShell: the shared layout primitives carry the
 *  label, error/hint precedence and the dialog dismiss contract.
 *--------------------------------------------------------------------------------------------*/

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FormField, FormSection } from '../forms/Form.js'
import { ModalShell } from '../overlay/ModalShell.js'

afterEach(cleanup)

describe('FormField', () => {
  it('shows the hint only while there is no error', () => {
    const { rerender } = render(
      <FormField label="Name" hint="Shown under the field">
        <input />
      </FormField>,
    )
    expect(screen.getByText('Shown under the field')).toBeDefined()

    rerender(
      <FormField label="Name" hint="Shown under the field" error="Required">
        <input />
      </FormField>,
    )
    expect(screen.getByText('Required')).toBeDefined()
    expect(screen.queryByText('Shown under the field')).toBeNull()
  })

  it('keeps the label next to its control with an optional test id', () => {
    render(
      <FormField label="Name" data-testid="name-field">
        <input aria-label="name" />
      </FormField>,
    )
    expect(screen.getByTestId('name-field').contains(screen.getByLabelText('name'))).toBe(true)
    expect(screen.getByTestId('name-field').textContent).toContain('Name')
  })
})

describe('FormSection', () => {
  it('renders the title, actions and children in one section', () => {
    render(
      <FormSection title="Basics" actions={<button type="button">Edit</button>} data-testid="sec">
        <span>body</span>
      </FormSection>,
    )
    const section = screen.getByTestId('sec')
    expect(section.tagName).toBe('SECTION')
    expect(section.textContent).toContain('Basics')
    expect(section.textContent).toContain('body')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined()
  })
})

describe('ModalShell', () => {
  it('dismisses on backdrop click and Escape unless disabled', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <ModalShell title="New thing" onDismiss={onDismiss} data-testid="modal">
        <span>content</span>
      </ModalShell>,
    )
    fireEvent.click(screen.getByTestId('modal').previousElementSibling as Element)
    expect(onDismiss).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(2)

    rerender(
      <ModalShell title="New thing" onDismiss={onDismiss} dismissDisabled data-testid="modal">
        <span>content</span>
      </ModalShell>,
    )
    fireEvent.click(screen.getByTestId('modal').previousElementSibling as Element)
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })
})
