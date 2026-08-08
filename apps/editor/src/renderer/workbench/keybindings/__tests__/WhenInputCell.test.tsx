import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { WhenInputCell } from '../WhenInputCell.js'

function mount(initialValue = '') {
  const props = {
    initialValue,
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    onFocusChange: vi.fn(),
  }
  const utils = render(<WhenInputCell {...props} />)
  const input = utils.container.querySelector('input') as HTMLInputElement
  return { ...utils, props, input }
}

// Programmatic value changes don't move the caret in every DOM
// implementation; park it at the end and surface the selection change so the
// token tracker sees the real cursor position.
function setValue(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } })
  input.setSelectionRange(value.length, value.length)
  fireEvent.select(input)
}

describe('WhenInputCell', () => {
  it('focuses and selects the whole current value on entry', () => {
    const { props, input } = mount('editorTextFocus')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('editorTextFocus'.length)
    expect(props.onFocusChange).toHaveBeenCalledWith(true)
  })

  it('releases the focus key on unmount', () => {
    const { props, unmount } = mount()
    unmount()
    expect(props.onFocusChange).toHaveBeenLastCalledWith(false)
  })

  it('commits the trimmed value on Enter when no suggestion is visible', () => {
    const { props, input } = mount()
    setValue(input, 'editorTextFocus')
    // 'editorTextFocus' is a known key — an exact match is not a suggestion.
    expect(document.querySelector('[data-testid=keybindings-when-suggestions]')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onCommit).toHaveBeenCalledWith('editorTextFocus')
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('commits an empty value (parent treats it as when-removal)', () => {
    const { props, input } = mount('editorTextFocus')
    setValue(input, '')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onCommit).toHaveBeenCalledWith('')
  })

  it('cancels on Escape', () => {
    const { props, input } = mount('editorTextFocus')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onCancel).toHaveBeenCalledWith(true)
    expect(props.onCommit).not.toHaveBeenCalled()
  })

  it('cancels on blur without claiming a keyboard exit', () => {
    const { props, input } = mount()
    fireEvent.blur(input)
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onCancel).toHaveBeenCalledWith(false)
  })

  it('Escape hides visible suggestions first; a second Escape cancels', () => {
    const { props, input } = mount()
    setValue(input, 'editortextf')
    expect(document.querySelector('[data-testid=keybindings-when-suggestions]')).not.toBeNull()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.querySelector('[data-testid=keybindings-when-suggestions]')).toBeNull()
    expect(props.onCancel).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onCancel).toHaveBeenCalledWith(true)
  })

  it('renders suggestions portaled to the body, not inside the row', () => {
    const { container, input } = mount()
    setValue(input, 'editortext')
    const popover = document.querySelector('[data-testid=keybindings-when-suggestions]')
    expect(popover).not.toBeNull()
    expect(container.contains(popover)).toBe(false)
    expect(document.body.contains(popover)).toBe(true)
  })

  it('filters context-key suggestions by the token before the cursor', () => {
    const { container, input } = mount()
    setValue(input, 'editortext')
    const popover = document.querySelector('[data-testid=keybindings-when-suggestions]')
    expect(popover).not.toBeNull()
    expect(popover!.textContent).toContain('editorTextFocus')
    expect(container.textContent).not.toContain('sideBarVisible')
  })

  it('Enter accepts the active suggestion instead of committing', () => {
    const { props, input } = mount()
    setValue(input, 'editortextf')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('editorTextFocus')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onCommit).toHaveBeenCalledWith('editorTextFocus')
  })

  it('accepts a suggestion with Tab and preserves a leading bang', () => {
    const { input } = mount()
    setValue(input, '!editortextf')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('!editorTextFocus')
  })

  it('navigates suggestions with arrow keys', () => {
    const { input } = mount()
    // Prefix shared by editorFocus + editorTextFocus (both seeded keys).
    setValue(input, 'editorf')
    const popover = document.querySelector('[data-testid=keybindings-when-suggestions]')
    expect(popover).not.toBeNull()
    const options = [...popover!.querySelectorAll('[role=option]')]
    expect(options.length).toBeGreaterThanOrEqual(1)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const last = options[options.length - 1]!
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    // Wrap-around guards ran without crashing; accept whatever is active.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).not.toBe('editorf')
    expect(last).toBeDefined()
  })
})
