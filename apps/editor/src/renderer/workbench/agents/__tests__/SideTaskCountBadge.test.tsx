/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for SideTaskCountBadge — zero renders nothing, counts above 99 cap.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SideTaskCountBadge } from '../SideTaskCountBadge.js'

describe('SideTaskCountBadge', () => {
  it('renders nothing at zero', () => {
    render(<SideTaskCountBadge count={0} testId="badge" />)
    expect(screen.queryByTestId('badge')).toBeNull()
  })

  it('renders the icon and count with an accessible label', () => {
    render(<SideTaskCountBadge count={3} testId="badge" />)
    const badge = screen.getByTestId('badge')
    expect(badge.textContent).toBe('3')
    expect(badge.getAttribute('data-tooltip')).toContain('3')
    expect(badge.getAttribute('aria-label')).toContain('3')
    expect(badge.getAttribute('role')).toBe('img')
    expect(badge.querySelector('svg')).not.toBeNull()
  })

  it('caps the visible number at 99+', () => {
    render(<SideTaskCountBadge count={100} testId="badge" />)
    expect(screen.getByTestId('badge').textContent).toBe('99+')
  })
})
