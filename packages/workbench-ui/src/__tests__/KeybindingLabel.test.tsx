import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { KeybindingLabel } from '../keybinding/KeybindingLabel.js'
import keyStyles from '../keybinding/KeybindingLabel.module.css'

describe('KeybindingLabel', () => {
  afterEach(cleanup)

  it('renders each key of each chord as a key block', () => {
    const { container } = render(
      <KeybindingLabel
        chords={[
          ['Ctrl', 'K'],
          ['Ctrl', 'S'],
        ]}
      />,
    )
    expect(container.textContent).toBe('CtrlK CtrlS')
    const keys = Array.from(container.querySelectorAll(`.${keyStyles['key']}`)).map(
      (el) => el.textContent,
    )
    expect(keys).toEqual(['Ctrl', 'K', 'Ctrl', 'S'])
  })

  it('separates chords with a plain space', () => {
    const { container } = render(<KeybindingLabel chords={[['Ctrl', 'K'], ['S']]} />)
    const label = container.firstElementChild!
    expect(label.childNodes).toHaveLength(2)
    expect(label.childNodes[1]!.textContent).toBe(' S')
  })

  it('marks highlighted keys from the parallel highlights structure', () => {
    const { container } = render(
      <KeybindingLabel
        chords={[
          ['Ctrl', 'K'],
          ['Ctrl', 'S'],
        ]}
        highlights={[
          [false, true],
          [true, false],
        ]}
      />,
    )
    const highlighted = Array.from(container.querySelectorAll(`.${keyStyles['highlight']}`)).map(
      (el) => el.textContent,
    )
    expect(highlighted).toEqual(['K', 'Ctrl'])
  })

  it('tolerates missing or shorter highlights', () => {
    const { container, rerender } = render(<KeybindingLabel chords={[['Ctrl', 'K']]} />)
    expect(container.querySelectorAll(`.${keyStyles['highlight']}`)).toHaveLength(0)

    rerender(<KeybindingLabel chords={[['Ctrl', 'K']]} highlights={[[true]]} />)
    const highlighted = Array.from(container.querySelectorAll(`.${keyStyles['highlight']}`)).map(
      (el) => el.textContent,
    )
    expect(highlighted).toEqual(['Ctrl'])
  })

  it('renders an empty label for no chords', () => {
    const { container } = render(<KeybindingLabel chords={[]} />)
    expect(container.textContent).toBe('')
  })
})
