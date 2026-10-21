import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IDisposable } from '@universe-editor/platform'
import {
  currentWorkbenchDocumentOrUndefined,
  getActiveWorkbenchDocument,
  getDocumentForNode,
  getWorkbenchDocuments,
  onDidAddWorkbenchDocument,
  onDidRemoveWorkbenchDocument,
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
  workbenchDocumentOrMain,
} from '../workbenchDocuments.js'
import { installPerWorkbenchDocument } from '../workbenchDocumentEvents.js'

let registrations = new Map<Document, IDisposable>()
let extraDisposables: IDisposable[] = []

function fakeDocument(name: string): Document {
  return { name } as unknown as Document
}

function register(doc: Document): Document {
  const registration = registerWorkbenchDocument(doc)
  if (!registrations.has(doc)) registrations.set(doc, registration)
  return doc
}

function unregister(doc: Document): void {
  registrations.get(doc)?.dispose()
  registrations.delete(doc)
}

afterEach(() => {
  for (const disposable of extraDisposables.reverse()) disposable.dispose()
  for (const disposable of [...registrations.values()].reverse()) disposable.dispose()
  extraDisposables = []
  registrations = new Map()
  vi.unstubAllGlobals()
})

describe('registerWorkbenchDocument', () => {
  it('makes the first document active', () => {
    const first = register(fakeDocument('first'))

    expect(getWorkbenchDocuments()).toEqual([first])
    expect(currentWorkbenchDocumentOrUndefined()).toBe(first)

    setActiveWorkbenchDocument(first)
    expect(currentWorkbenchDocumentOrUndefined()).toBe(first)
  })

  it('announces added documents without stealing the active one', () => {
    const first = register(fakeDocument('first'))
    const added = vi.fn()
    extraDisposables.push(onDidAddWorkbenchDocument(added))

    const second = register(fakeDocument('second'))
    register(second)

    expect(added).toHaveBeenCalledTimes(1)
    expect(added).toHaveBeenCalledWith(second)
    expect(currentWorkbenchDocumentOrUndefined()).toBe(first)
  })

  it('falls back to the first surviving document when the active one is removed', () => {
    const first = register(fakeDocument('first'))
    const second = register(fakeDocument('second'))
    const removed = vi.fn()
    extraDisposables.push(onDidRemoveWorkbenchDocument(removed))

    setActiveWorkbenchDocument(second)
    unregister(second)

    expect(removed).toHaveBeenCalledWith(second)
    expect(getWorkbenchDocuments()).toEqual([first])
    expect(currentWorkbenchDocumentOrUndefined()).toBe(first)
  })

  it('keeps the active document when a background one is removed', () => {
    const first = register(fakeDocument('first'))
    const second = register(fakeDocument('second'))
    setActiveWorkbenchDocument(second)

    unregister(first)

    expect(currentWorkbenchDocumentOrUndefined()).toBe(second)
  })
})

describe('setActiveWorkbenchDocument', () => {
  it('ignores documents that were never registered', () => {
    const first = register(fakeDocument('first'))

    setActiveWorkbenchDocument(fakeDocument('unknown'))

    expect(currentWorkbenchDocumentOrUndefined()).toBe(first)
  })

  it('switches between registered documents', () => {
    register(fakeDocument('first'))
    const second = register(fakeDocument('second'))

    setActiveWorkbenchDocument(second)

    expect(currentWorkbenchDocumentOrUndefined()).toBe(second)
  })
})

describe('document fallbacks', () => {
  it('returns the active document, then the global one, then undefined', () => {
    const store = globalThis as { document?: Document }
    const original = store.document
    delete store.document

    try {
      expect(currentWorkbenchDocumentOrUndefined()).toBeUndefined()

      const globalDocument = fakeDocument('main')
      vi.stubGlobal('document', globalDocument)
      expect(currentWorkbenchDocumentOrUndefined()).toBe(globalDocument)
      expect(getActiveWorkbenchDocument()).toBe(globalDocument)

      const aux = register(fakeDocument('aux'))
      expect(currentWorkbenchDocumentOrUndefined()).toBe(aux)
      expect(getActiveWorkbenchDocument()).toBe(aux)
    } finally {
      if (original === undefined) delete store.document
      else store.document = original
    }
  })

  it('workbenchDocumentOrMain keeps live documents and falls back otherwise', () => {
    const globalDocument = fakeDocument('main')
    vi.stubGlobal('document', globalDocument)
    const aux = register(fakeDocument('aux'))

    expect(workbenchDocumentOrMain(aux)).toBe(aux)
    expect(workbenchDocumentOrMain(fakeDocument('closed'))).toBe(globalDocument)
    expect(workbenchDocumentOrMain(undefined)).toBe(globalDocument)
  })

  it('getDocumentForNode takes the owner document and falls back to the active one', () => {
    const aux = register(fakeDocument('aux'))
    setActiveWorkbenchDocument(aux)

    expect(getDocumentForNode({ ownerDocument: aux } as unknown as Node)).toBe(aux)
    expect(getDocumentForNode(null)).toBe(aux)
  })
})

describe('installPerWorkbenchDocument', () => {
  it('attaches existing and future documents, detaching removed ones', () => {
    const first = register(fakeDocument('first'))
    const attached: Document[] = []
    const offs = new Map<Document, ReturnType<typeof vi.fn>>()

    extraDisposables.push(
      installPerWorkbenchDocument((doc) => {
        attached.push(doc)
        const off = vi.fn()
        offs.set(doc, off)
        return { dispose: off }
      }),
    )

    expect(attached).toEqual([first])

    const second = register(fakeDocument('second'))
    expect(attached).toEqual([first, second])

    unregister(second)
    expect(offs.get(second)).toHaveBeenCalledTimes(1)
    expect(offs.get(first)).not.toHaveBeenCalled()
  })

  it('falls back to the global document when nothing is registered', () => {
    const globalDocument = fakeDocument('main')
    vi.stubGlobal('document', globalDocument)
    const attach = vi.fn(() => ({ dispose: vi.fn() }))

    const subscription = installPerWorkbenchDocument(attach)
    expect(attach).toHaveBeenCalledWith(globalDocument)
    subscription.dispose()
  })

  it('disposes every attachment and stops following the registry', () => {
    register(fakeDocument('first'))
    const offs: ReturnType<typeof vi.fn>[] = []
    const subscription = installPerWorkbenchDocument(() => {
      const off = vi.fn()
      offs.push(off)
      return { dispose: off }
    })

    register(fakeDocument('second'))
    expect(offs).toHaveLength(2)

    subscription.dispose()
    expect(offs.every((off) => off.mock.calls.length === 1)).toBe(true)

    register(fakeDocument('third'))
    expect(offs).toHaveLength(2)
  })
})
