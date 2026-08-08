import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { DefineKeybindingOverlay } from '../DefineKeybindingOverlay.js'

function mount(overrides: Partial<Parameters<typeof DefineKeybindingOverlay>[0]> = {}) {
  const props = {
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    countConflicts: vi.fn(() => 0),
    onShowConflicts: vi.fn(),
    ...overrides,
  }
  const utils = render(<DefineKeybindingOverlay {...props} />)
  return { ...utils, props }
}

function press(init: KeyboardEventInit) {
  fireEvent.keyDown(window, init)
}

describe('DefineKeybindingOverlay', () => {
  it('records a single stroke and confirms it on Enter', () => {
    const { props, container } = mount()
    press({ key: 'k', ctrlKey: true })
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Ctrl')
    expect(container.textContent).toContain('K')

    press({ key: 'Enter' })
    expect(props.onConfirm).toHaveBeenCalledWith('ctrl+k')
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('records a 2-stroke chord and renders the chord-to separator', () => {
    const { props, container } = mount()
    press({ key: 'k', ctrlKey: true })
    press({ key: 's', ctrlKey: true })
    expect(container.textContent).toContain('chord to')

    press({ key: 'Enter' })
    expect(props.onConfirm).toHaveBeenCalledWith('ctrl+k ctrl+s')
  })

  it('clears a full chord and restarts recording on the next key', () => {
    const { props } = mount()
    press({ key: 'k', ctrlKey: true })
    press({ key: 's', ctrlKey: true })
    press({ key: 'x', altKey: true })

    press({ key: 'Enter' })
    expect(props.onConfirm).toHaveBeenCalledWith('alt+x')
  })

  it('ignores modifier-only presses (they never form a segment)', () => {
    const { props, container } = mount()
    press({ key: 'Control', ctrlKey: true })
    press({ key: 'Shift', shiftKey: true })
    expect(container.textContent).not.toContain('Ctrl')

    press({ key: 'Enter' })
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape clears recorded strokes first and cancels only when empty', () => {
    const { props, container } = mount()
    press({ key: 'k', ctrlKey: true })
    press({ key: 'Escape' })
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Ctrl')

    press({ key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('Enter with nothing recorded cancels', () => {
    const { props } = mount()
    press({ key: 'Enter' })
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('cancels when the widget loses focus', () => {
    const { props, container } = mount()
    const widget = container.querySelector('[role=dialog]') as HTMLElement
    fireEvent.blur(widget)
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows a clickable conflict count while strokes are recorded', () => {
    const { props, container } = mount({ countConflicts: vi.fn(() => 2) })
    expect(container.textContent).not.toContain('existing commands')

    press({ key: 'k', ctrlKey: true })
    const conflict = [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('2 existing commands have this keybinding'),
    )
    expect(conflict).toBeDefined()

    fireEvent.click(conflict!)
    expect(props.onShowConflicts).toHaveBeenCalledWith('ctrl+k')
  })
})
