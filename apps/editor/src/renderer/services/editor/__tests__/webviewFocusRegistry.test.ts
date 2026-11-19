import { afterEach, describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import { WebviewFocusRegistry } from '../WebviewFocusRegistry.js'
import {
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
} from '../../windows/workbenchDocuments.js'

const RESOURCE = URI.file('/workspace/doc.pdf')
const registrations: { dispose(): void }[] = []

afterEach(() => {
  WebviewFocusRegistry._resetForTests()
  for (const registration of registrations.splice(0)) registration.dispose()
})

describe('WebviewFocusRegistry', () => {
  it('focuses the requested group’s iframe even when another group registered last', () => {
    const mainFocus = vi.fn()
    const auxFocus = vi.fn()
    WebviewFocusRegistry.register('pdf.preview', RESOURCE, { focus: auxFocus }, { groupId: 2 })
    WebviewFocusRegistry.register('pdf.preview', RESOURCE, { focus: mainFocus }, { groupId: 1 })

    expect(WebviewFocusRegistry.requestFocus('pdf.preview', RESOURCE, 2)).toBe(true)
    expect(auxFocus).toHaveBeenCalledTimes(1)
    expect(mainFocus).not.toHaveBeenCalled()
  })

  it('only fulfils a pending group request when that group registers', () => {
    const mainFocus = vi.fn()
    const auxFocus = vi.fn()
    WebviewFocusRegistry.requestFocus('pdf.preview', RESOURCE, 2)

    WebviewFocusRegistry.register('pdf.preview', RESOURCE, { focus: mainFocus }, { groupId: 1 })
    expect(mainFocus).not.toHaveBeenCalled()

    WebviewFocusRegistry.register('pdf.preview', RESOURCE, { focus: auxFocus }, { groupId: 2 })
    expect(auxFocus).toHaveBeenCalledTimes(1)
  })

  it('prefers the active workbench document when no group is requested', () => {
    const mainFocus = vi.fn()
    const auxFocus = vi.fn()
    const auxDocument = {} as unknown as Document
    registrations.push(registerWorkbenchDocument(auxDocument))
    setActiveWorkbenchDocument(auxDocument)

    WebviewFocusRegistry.register(
      'pdf.preview',
      RESOURCE,
      { focus: auxFocus },
      { groupId: 2, ownerDocument: auxDocument },
    )
    WebviewFocusRegistry.register('pdf.preview', RESOURCE, { focus: mainFocus }, { groupId: 1 })

    expect(WebviewFocusRegistry.requestFocus('pdf.preview', RESOURCE)).toBe(true)
    expect(auxFocus).toHaveBeenCalledTimes(1)
    expect(mainFocus).not.toHaveBeenCalled()
  })
})
