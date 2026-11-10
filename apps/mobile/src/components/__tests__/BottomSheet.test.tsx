import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BottomSheet } from '../BottomSheet.js'

const LOCK_CLASS = 'is-scroll-locked'

function renderOverlay(testId: string) {
  return render(
    <BottomSheet title="Workspaces" testId={testId} overlay onDismiss={vi.fn()}>
      <p>body</p>
    </BottomSheet>,
  )
}

describe('BottomSheet', () => {
  it('locks document scrolling while an overlay is open and restores it on unmount', () => {
    const { unmount } = renderOverlay('workspace-sheet')

    expect(document.documentElement.classList.contains(LOCK_CLASS)).toBe(true)
    expect(screen.getByTestId('workspace-sheet')).toBeTruthy()

    unmount()
    expect(document.documentElement.classList.contains(LOCK_CLASS)).toBe(false)
  })

  it('keeps the lock until the last nested overlay closes', () => {
    const first = renderOverlay('first-sheet')
    const second = renderOverlay('second-sheet')

    first.unmount()
    expect(document.documentElement.classList.contains(LOCK_CLASS)).toBe(true)

    second.unmount()
    expect(document.documentElement.classList.contains(LOCK_CLASS)).toBe(false)
  })

  it('leaves document scrolling alone for inline footer sheets', () => {
    render(
      <BottomSheet title="Permission" testId="permission-sheet">
        <p>body</p>
      </BottomSheet>,
    )

    expect(document.documentElement.classList.contains(LOCK_CLASS)).toBe(false)
  })

  it('portals overlay sheets to the body so scroll ancestors cannot clip them', () => {
    const { container } = renderOverlay('portal-sheet')
    const sheet = screen.getByTestId('portal-sheet')

    expect(container.contains(sheet)).toBe(false)
    expect(document.body.contains(sheet)).toBe(true)

    const backdrop = screen.getByTestId('portal-sheet-backdrop')
    expect(container.contains(backdrop)).toBe(false)
  })
})
