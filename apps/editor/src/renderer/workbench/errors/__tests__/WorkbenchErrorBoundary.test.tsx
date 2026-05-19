/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/errors/WorkbenchErrorBoundary.tsx
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { NullLogger } from '@universe-editor/platform'
import { WorkbenchErrorBoundary } from '../WorkbenchErrorBoundary.js'

afterEach(() => cleanup())

// Helper: a component that throws on render
function BrokenChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('intentional test error')
  return <span>ok</span>
}

describe('WorkbenchErrorBoundary', () => {
  it('renders children normally when no error occurs', () => {
    const logger = new NullLogger()
    render(
      <WorkbenchErrorBoundary logger={logger}>
        <BrokenChild shouldThrow={false} />
      </WorkbenchErrorBoundary>,
    )
    expect(screen.getByText('ok')).toBeDefined()
    expect(screen.queryByTestId('workbench-error-boundary')).toBeNull()
  })

  it('shows fallback UI with reload button when a child throws', () => {
    // Suppress console.error noise from React during error boundary tests
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const logger = new NullLogger()
    render(
      <WorkbenchErrorBoundary logger={logger}>
        <BrokenChild shouldThrow={true} />
      </WorkbenchErrorBoundary>,
    )

    expect(screen.getByTestId('workbench-error-boundary')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reload Window' })).toBeDefined()

    errSpy.mockRestore()
  })
})
