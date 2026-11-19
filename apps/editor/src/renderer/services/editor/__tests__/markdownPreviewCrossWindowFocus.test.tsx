/*---------------------------------------------------------------------------------------------
 *  Repro: focusing a markdown preview inside an auxiliary window after the
 *  same source's preview was (re)mounted in the main window last.
 *
 *  `MarkdownPreviewRegistry` used to be keyed by source URI only and `get()`
 *  returned the most recently registered controller, without any group/window
 *  association. `MarkdownPreviewInput.focus()` routed through that `get()`, and
 *  `focusEditorInput(input, cxt, groupId)` dropped the `groupId` before calling
 *  `input.focus()`. With two mounted previews of the same file (e.g. "Copy
 *  Editor into New Window", or a restored workspace with duplicate previews),
 *  a focus request issued while the auxiliary group is active therefore focused
 *  the MAIN window's preview element. That cannot move the OS window focus, so
 *  the auxiliary document kept whatever held focus (typically its tab), the
 *  preview's bubble-phase keydown listener never saw the key, and j/k stopped
 *  scrolling there while the main window kept working.
 *
 *  These tests pin the observable contract at that seam: focus must land on the
 *  controller of the group that owns the input, regardless of registration
 *  order, and group-less resolution must prefer the active workbench document.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextKeyService, URI } from '@universe-editor/platform'
import { focusEditorInput } from '../editorFocus.js'
import { MarkdownPreviewInput } from '../MarkdownPreviewInput.js'
import {
  MarkdownPreviewRegistry,
  type IMarkdownPreviewController,
} from '../MarkdownPreviewRegistry.js'
import {
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
} from '../../windows/workbenchDocuments.js'

function makeController(onFocus: () => void): IMarkdownPreviewController {
  return {
    scrollToLine: () => undefined,
    scrollToAnchor: () => undefined,
    getTopVisibleLine: () => undefined,
    isScrolledToBottom: () => false,
    focus: onFocus,
    onDidScroll: () => ({ dispose: () => undefined }),
    openFind: () => undefined,
    closeFind: () => undefined,
    findNext: () => undefined,
    findPrev: () => undefined,
    showLinkHints: () => undefined,
    hideLinkHints: () => undefined,
    toggleHelp: () => undefined,
  }
}

const documentRegistrations: { dispose(): void }[] = []

afterEach(() => {
  MarkdownPreviewRegistry._resetForTests()
  for (const registration of documentRegistrations.splice(0)) registration.dispose()
})

describe('focusEditorInput — markdown preview across editor windows', () => {
  it('focuses the requested group controller even when another window registered last', () => {
    const contextKeyService = new ContextKeyService()
    const source = URI.file('/workspace/doc.md')
    const auxGroupId = 2
    const mainFocus = vi.fn()
    const auxFocus = vi.fn()

    // Both windows show the same source. The main preview was remounted last
    // (switch tabs away and back), so a URI-only registry would resolve to it
    // even though the user is working in the auxiliary window.
    MarkdownPreviewRegistry.register(source, makeController(auxFocus), {
      groupId: auxGroupId,
      ownerDocument: document,
    })
    MarkdownPreviewRegistry.register(source, makeController(mainFocus), {
      groupId: 1,
      ownerDocument: document,
    })

    const handled = focusEditorInput(
      new MarkdownPreviewInput(source),
      contextKeyService,
      auxGroupId,
    )

    expect(handled).toBe(true)
    expect(auxFocus).toHaveBeenCalledTimes(1)
    expect(mainFocus).not.toHaveBeenCalled()
  })

  it('focuses the requested group controller when it registered last (control)', () => {
    const contextKeyService = new ContextKeyService()
    const source = URI.file('/workspace/doc.md')
    const auxGroupId = 2
    const mainFocus = vi.fn()
    const auxFocus = vi.fn()

    MarkdownPreviewRegistry.register(source, makeController(mainFocus), {
      groupId: 1,
      ownerDocument: document,
    })
    MarkdownPreviewRegistry.register(source, makeController(auxFocus), {
      groupId: auxGroupId,
      ownerDocument: document,
    })

    const handled = focusEditorInput(
      new MarkdownPreviewInput(source),
      contextKeyService,
      auxGroupId,
    )

    expect(handled).toBe(true)
    expect(auxFocus).toHaveBeenCalledTimes(1)
    expect(mainFocus).not.toHaveBeenCalled()
  })
})

describe('MarkdownPreviewRegistry — group/document resolution', () => {
  it('resolves the exact group regardless of registration order', () => {
    const source = URI.file('/workspace/doc.md')
    const main = makeController(() => undefined)
    const aux = makeController(() => undefined)

    MarkdownPreviewRegistry.register(source, aux, { groupId: 2 })
    MarkdownPreviewRegistry.register(source, main, { groupId: 1 })

    expect(MarkdownPreviewRegistry.get(source, 2)).toBe(aux)
    expect(MarkdownPreviewRegistry.get(source, 1)).toBe(main)
  })

  it('prefers a controller mounted in the active workbench document when no group is given', () => {
    const source = URI.file('/workspace/doc.md')
    const main = makeController(() => undefined)
    const aux = makeController(() => undefined)
    const auxDocument = document.implementation.createHTMLDocument('aux')
    documentRegistrations.push(registerWorkbenchDocument(auxDocument))
    setActiveWorkbenchDocument(auxDocument)

    // Main registered last, but the auxiliary window is the active document.
    MarkdownPreviewRegistry.register(source, aux, { groupId: 2, ownerDocument: auxDocument })
    MarkdownPreviewRegistry.register(source, main, { groupId: 1, ownerDocument: document })

    expect(MarkdownPreviewRegistry.get(source)).toBe(aux)
  })

  it('falls back to the most recent registration when no document matches', () => {
    const source = URI.file('/workspace/doc.md')
    const first = makeController(() => undefined)
    const second = makeController(() => undefined)
    const foreignDocument = document.implementation.createHTMLDocument('foreign')

    MarkdownPreviewRegistry.register(source, first, { ownerDocument: foreignDocument })
    MarkdownPreviewRegistry.register(source, second, { ownerDocument: foreignDocument })

    expect(MarkdownPreviewRegistry.get(source)).toBe(second)
  })
})
