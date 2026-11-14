/*---------------------------------------------------------------------------------------------
 *  Tests for the Textarea atom: value/change wiring, the invalid flag and the
 *  disabled state (mirrors the Input contract).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { Textarea } from '../atoms/Textarea.js'

afterEach(() => {
  cleanup()
})

describe('Textarea', () => {
  it('renders the value and reports changes', () => {
    const onChange = vi.fn()
    render(<Textarea value="hello" onChange={onChange} data-testid="t" />)

    const textarea = screen.getByTestId('t') as HTMLTextAreaElement
    expect(textarea.value).toBe('hello')

    fireEvent.change(textarea, { target: { value: 'world' } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('marks invalid fields for assistive tech', () => {
    render(<Textarea invalid data-testid="t" />)
    expect(screen.getByTestId('t').getAttribute('aria-invalid')).toBe('true')
  })

  it('passes the disabled state through', () => {
    render(<Textarea disabled data-testid="t" />)
    expect((screen.getByTestId('t') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('forwards the ref to the textarea element', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<Textarea ref={ref} data-testid="t" />)
    expect(ref.current).toBe(screen.getByTestId('t'))
  })
})
