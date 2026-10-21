import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { OwnerDocumentProvider, useOwnerDocument } from '../overlay/ownerDocumentContext.js'

function Probe({ explicit }: { explicit?: Document }) {
  const doc = useOwnerDocument(explicit)
  return (
    <span data-testid="doc">{doc === undefined ? 'none' : doc === document ? 'main' : 'aux'}</span>
  )
}

describe('ownerDocumentContext', () => {
  afterEach(cleanup)

  it('falls back to the global document without a provider', () => {
    render(<Probe />)
    expect(screen.getByTestId('doc').textContent).toBe('main')
  })

  it('takes the provider document', () => {
    const aux = new Window().document as unknown as Document
    render(
      <OwnerDocumentProvider targetDocument={aux}>
        <Probe />
      </OwnerDocumentProvider>,
    )
    expect(screen.getByTestId('doc').textContent).toBe('aux')
  })

  it('lets an explicit prop override the provider', () => {
    const aux = new Window().document as unknown as Document
    render(
      <OwnerDocumentProvider targetDocument={aux}>
        <Probe explicit={document} />
      </OwnerDocumentProvider>,
    )
    expect(screen.getByTestId('doc').textContent).toBe('main')
  })
})
