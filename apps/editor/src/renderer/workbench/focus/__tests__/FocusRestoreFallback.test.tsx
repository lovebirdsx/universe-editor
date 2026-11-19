/*---------------------------------------------------------------------------------------------
 *  The workbench-wide focus-restore fallback: when an overlay's captured opener
 *  left the document (an editor remounted while the overlay was up), the restore
 *  must land in the active editor instead of leaving the caret on <body>.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { IContextKeyService, IEditorGroupsService } from '@universe-editor/platform'
import { useContext } from 'react'
import { FocusRestoreFallbackContext, useFocusRestore } from '@universe-editor/workbench-ui'
import { ServicesContext } from '../../useService.js'
import { focusEditorInput } from '../../../services/editor/editorFocus.js'
import { FocusRestoreFallbackProvider } from '../FocusRestoreFallback.js'

vi.mock('../../../services/editor/editorFocus.js', () => ({
  focusEditorInput: vi.fn(() => true),
}))

const focusEditorInputMock = vi.mocked(focusEditorInput)

async function flushRestore(): Promise<void> {
  await act(async () => {})
}

function makeServices() {
  const activeEditor = { id: 'editor-1' }
  const activeGroup = { id: 3, activeEditor }
  const editorGroupsService = { activeGroup }
  const contextKeyService = {}
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({
        get: (id: unknown) => {
          if (id === IEditorGroupsService) return editorGroupsService
          if (id === IContextKeyService) return contextKeyService
          return undefined
        },
      }),
  }
  return { container, activeEditor, contextKeyService }
}

function Host({ visible }: { visible: boolean }) {
  useFocusRestore(visible, {})
  return visible ? <button data-testid="inside">inside</button> : null
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  focusEditorInputMock.mockClear()
})

describe('FocusRestoreFallbackProvider', () => {
  it('focuses the active editor when the captured opener left the document', async () => {
    const { container, activeEditor, contextKeyService } = makeServices()

    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const view = render(
      <ServicesContext.Provider value={container as never}>
        <FocusRestoreFallbackProvider>
          <Host visible={false} />
        </FocusRestoreFallbackProvider>
      </ServicesContext.Provider>,
    )

    view.rerender(
      <ServicesContext.Provider value={container as never}>
        <FocusRestoreFallbackProvider>
          <Host visible />
        </FocusRestoreFallbackProvider>
      </ServicesContext.Provider>,
    )
    const inside = document.querySelector('[data-testid="inside"]') as HTMLElement
    inside.focus()

    // The editor host was remounted while the overlay was up.
    opener.remove()
    ;(document.activeElement as HTMLElement | null)?.blur()

    view.rerender(
      <ServicesContext.Provider value={container as never}>
        <FocusRestoreFallbackProvider>
          <Host visible={false} />
        </FocusRestoreFallbackProvider>
      </ServicesContext.Provider>,
    )
    await flushRestore()

    expect(focusEditorInputMock).toHaveBeenCalledTimes(1)
    expect(focusEditorInputMock).toHaveBeenCalledWith(activeEditor, contextKeyService, 3)
  })

  it('does not fall back for an overlay hosted by an inactive window', () => {
    const { container } = makeServices()
    let fallback: ((doc: Document) => boolean) | undefined
    function Probe() {
      fallback = useContext(FocusRestoreFallbackContext)
      return null
    }
    render(
      <ServicesContext.Provider value={container as never}>
        <FocusRestoreFallbackProvider>
          <Probe />
        </FocusRestoreFallbackProvider>
      </ServicesContext.Provider>,
    )

    const otherWindowDocument = document.implementation.createHTMLDocument('aux')
    expect(fallback?.(otherWindowDocument)).toBe(false)
    expect(focusEditorInputMock).not.toHaveBeenCalled()
  })
})
