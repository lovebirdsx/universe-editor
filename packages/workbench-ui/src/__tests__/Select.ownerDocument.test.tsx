import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select } from '../atoms/Select.js'
import { OwnerDocumentProvider } from '../overlay/ownerDocumentContext.js'

describe('Select — owner document', () => {
  afterEach(cleanup)

  it('portals the popover into the provider document and dismisses there', () => {
    const win = new Window()
    const aux = win.document as unknown as Document
    render(
      <OwnerDocumentProvider targetDocument={aux}>
        <Select
          value="a"
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ]}
          onChange={() => undefined}
          data-testid="select"
        />
      </OwnerDocumentProvider>,
    )

    fireEvent.click(screen.getByTestId('select'))
    const popover = aux.querySelector<HTMLElement>('[role="listbox"]')
    expect(popover).not.toBeNull()
    expect(document.querySelector('[role="listbox"]')).toBeNull()

    // Escape from the main window must not close a popover owned by aux.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(aux.querySelector('[role="listbox"]')).not.toBeNull()

    fireEvent.keyDown(popover!, { key: 'Escape' })
    expect(aux.querySelector('[role="listbox"]')).toBeNull()
  })

  it('takes Ctrl+J/K from the popover document', () => {
    const win = new Window()
    const aux = win.document as unknown as Document
    render(
      <OwnerDocumentProvider targetDocument={aux}>
        <Select
          value="a"
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ]}
          onChange={() => undefined}
          data-testid="select"
        />
      </OwnerDocumentProvider>,
    )

    fireEvent.click(screen.getByTestId('select'))
    const popover = aux.querySelector<HTMLElement>('[role="listbox"]')!
    const alpha = aux.querySelector<HTMLElement>('[role="option"]')!
    act(() => alpha.focus())

    fireEvent.keyDown(popover, { key: 'j', ctrlKey: true })
    const options = Array.from(aux.querySelectorAll('[role="option"]'))
    expect(options[1]?.getAttribute('data-active')).toBe('true')
  })
})
