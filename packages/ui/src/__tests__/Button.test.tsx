import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

afterEach(cleanup)
import { Button } from '../Button.js'

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByRole('button', { name: 'Click me' })).toBeDefined()
  })

  it('applies primary variant by default', () => {
    render(<Button>Primary</Button>)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('ue-btn--primary')
  })

  it('applies secondary variant', () => {
    render(<Button variant="secondary">Secondary</Button>)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('ue-btn--secondary')
  })

  it('applies ghost variant', () => {
    render(<Button variant="ghost">Ghost</Button>)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('ue-btn--ghost')
  })

  it('applies sm size', () => {
    render(<Button size="sm">Small</Button>)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('ue-btn--sm')
  })

  it('merges custom className', () => {
    render(<Button className="custom-class">Custom</Button>)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('custom-class')
  })

  it('calls onClick when clicked', () => {
    let clicked = false
    render(
      <Button
        onClick={() => {
          clicked = true
        }}
      >
        Click
      </Button>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(clicked).toBe(true)
  })
})
