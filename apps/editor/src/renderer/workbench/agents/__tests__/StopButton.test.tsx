import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { StopButton } from '../StopButton.js'

afterEach(() => cleanup())

describe('StopButton', () => {
  it('triggers onCancel when clicked', () => {
    const onCancel = vi.fn()
    render(<StopButton onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('acp-prompt-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
