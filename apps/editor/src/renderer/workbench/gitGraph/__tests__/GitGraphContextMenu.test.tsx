/*---------------------------------------------------------------------------------------------
 *  GitGraphContextMenu — ListMenu keeps the clicked graph document ownership.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { GitGraphContextMenu } from '../GitGraphContextMenu.js'

afterEach(() => cleanup())

describe('GitGraphContextMenu', () => {
  it('portals into the graph document, not the main document', () => {
    const auxDoc = document.implementation.createHTMLDocument('aux')
    render(
      <GitGraphContextMenu
        state={{
          x: 0,
          y: 0,
          keyboard: false,
          contextTag: 'commit',
          items: [{ kind: 'item', id: 'copy-hash', label: 'Copy Hash', run: vi.fn() }],
        }}
        targetDocument={auxDoc}
        onClose={() => {}}
      />,
    )
    expect(auxDoc.querySelector('[role="menuitem"]')?.textContent).toContain('Copy Hash')
    expect(document.querySelector('[role="menuitem"]')).toBeNull()
  })
})
