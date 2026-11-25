import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMenuIcon } from '../menuIcon.js'

function renderIcon(icon: string | undefined): HTMLElement {
  return render(<>{renderMenuIcon(icon)}</>).container
}

describe('renderMenuIcon', () => {
  it('prefers the agent mark over a same-named codicon', () => {
    const container = renderIcon('claude')
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('.codicon-claude')).toBeNull()
  })

  it('renders any registered codicon', () => {
    const container = renderIcon('bracket')
    expect(container.querySelector('.codicon-bracket')).not.toBeNull()
  })

  it('renders nothing for an unknown id', () => {
    expect(renderIcon('acme.editor-service.nope').childElementCount).toBe(0)
  })
})
