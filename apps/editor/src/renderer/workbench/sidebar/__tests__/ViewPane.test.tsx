import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ViewPane } from '../ViewPane.js'

vi.mock('../../viewContainerHeader/ViewTitleActions.js', () => ({
  ViewTitleActions: () => null,
}))

vi.mock('../../viewContainerHeader/useViewScopedContextKey.js', () => ({
  useViewScopedContextKey: () => ({}),
}))

function renderPane(icon: string | undefined) {
  return render(
    <ViewPane viewId="test.view" title="Test View" icon={icon} open onToggle={() => undefined}>
      body
    </ViewPane>,
  ).container
}

describe('ViewPane title icon', () => {
  it('renders a curated Lucide icon as an svg', () => {
    const container = renderPane('files')
    expect(container.querySelector('svg.lucide-folder-tree')).not.toBeNull()
    expect(container.querySelector('.codicon-files')).toBeNull()
  })

  it('renders any registered codicon from the font', () => {
    const container = renderPane('folder')
    expect(container.querySelector('.codicon-folder')).not.toBeNull()
  })

  it('renders no icon when the view declares none', () => {
    const container = renderPane(undefined)
    expect(screen.getByText('Test View')).toBeTruthy()
    expect(container.querySelector('.codicon')).toBeNull()
    // Only the chevron remains.
    expect(container.querySelectorAll('svg')).toHaveLength(1)
  })
})
