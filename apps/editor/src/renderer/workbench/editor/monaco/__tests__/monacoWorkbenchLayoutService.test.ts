/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import type { IDisposable } from '@universe-editor/platform'

import {
  MONACO_LAYOUT_SERVICE_ID,
  monacoWorkbenchLayoutService,
} from '../monacoWorkbenchLayoutService.js'
import {
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
} from '../../../../services/windows/workbenchDocuments.js'

const originalDocument = globalThis.document

afterEach(() => {
  if (originalDocument === undefined) {
    // renderer-node environment has no DOM; restore the stub-free state.
    delete (globalThis as { document?: Document }).document
  } else {
    globalThis.document = originalDocument
  }
})

function stubDocument(root: HTMLElement | null): { root: HTMLElement | null; body: object } {
  const body = { tagName: 'BODY' }
  ;(globalThis as { document?: unknown }).document = {
    getElementById: (id: string) => (id === 'root' ? root : null),
    body,
    activeElement: null,
  }
  return { root, body }
}

describe('monacoWorkbenchLayoutService', () => {
  it('uses the monaco decorator id string', () => {
    expect(MONACO_LAYOUT_SERVICE_ID).toBe('layoutService')
  })

  it('resolves the app #root as the single hover/context-view container', () => {
    const root = { tagName: 'DIV' } as unknown as HTMLElement
    stubDocument(root)

    expect(monacoWorkbenchLayoutService.mainContainer).toBe(root)
    expect(monacoWorkbenchLayoutService.activeContainer).toBe(root)
    expect(monacoWorkbenchLayoutService.getContainer({ document: globalThis.document })).toBe(root)
    expect(monacoWorkbenchLayoutService.containers).toEqual([root])
  })

  it('resolves getContainer against the target window document', () => {
    stubDocument(null)
    const auxRoot = { tagName: 'DIV' } as unknown as HTMLElement
    const auxDocument = {
      getElementById: (id: string) => (id === 'root' ? auxRoot : null),
      body: { tagName: 'BODY' },
    } as unknown as Document

    expect(monacoWorkbenchLayoutService.getContainer({ document: auxDocument })).toBe(auxRoot)
  })

  it('getContainer falls back to the target document body when #root is missing', () => {
    const auxBody = { tagName: 'BODY' }
    const auxDocument = {
      getElementById: () => null,
      body: auxBody,
    } as unknown as Document

    expect(monacoWorkbenchLayoutService.getContainer({ document: auxDocument })).toBe(auxBody)
  })

  it('falls back to document.body when #root is missing', () => {
    const { body } = stubDocument(null)

    expect(monacoWorkbenchLayoutService.mainContainer).toBe(body)
  })

  it('exposes never-firing container lifecycle events', () => {
    const listener = () => {
      throw new Error('must never fire')
    }
    for (const event of [
      monacoWorkbenchLayoutService.onDidLayoutMainContainer,
      monacoWorkbenchLayoutService.onDidLayoutActiveContainer,
      monacoWorkbenchLayoutService.onDidLayoutContainer,
      monacoWorkbenchLayoutService.onDidChangeActiveContainer,
      monacoWorkbenchLayoutService.onDidAddContainer,
    ]) {
      const disposable = event(listener)
      disposable.dispose()
    }
  })
})

function fakeRoot(width = 0, height = 0): HTMLElement {
  return {
    tagName: 'DIV',
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as HTMLElement
}

function fakeDocument(name: string, root: HTMLElement): Document {
  return {
    name,
    getElementById: (id: string) => (id === 'root' ? root : null),
    body: { tagName: 'BODY' },
  } as unknown as Document
}

describe('multi-window containers', () => {
  const registrations: IDisposable[] = []
  const register = (doc: Document): Document => {
    registrations.push(registerWorkbenchDocument(doc))
    return doc
  }
  afterEach(() => {
    for (const registration of registrations.splice(0).reverse()) registration.dispose()
  })

  it('follows the active workbench document while mainContainer stays main', () => {
    const mainRoot = fakeRoot(800, 600)
    stubDocument(mainRoot)
    register(globalThis.document)
    const auxRoot = fakeRoot(400, 300)
    const auxDocument = register(fakeDocument('aux', auxRoot))

    expect(monacoWorkbenchLayoutService.mainContainer).toBe(mainRoot)
    expect(monacoWorkbenchLayoutService.activeContainer).toBe(mainRoot)
    expect(monacoWorkbenchLayoutService.containers).toEqual([mainRoot, auxRoot])

    setActiveWorkbenchDocument(auxDocument)

    expect(monacoWorkbenchLayoutService.mainContainer).toBe(mainRoot)
    expect(monacoWorkbenchLayoutService.activeContainer).toBe(auxRoot)
    expect(monacoWorkbenchLayoutService.activeContainerDimension).toEqual({
      width: 400,
      height: 300,
    })
    expect(monacoWorkbenchLayoutService.mainContainerDimension).toEqual({
      width: 800,
      height: 600,
    })
  })

  it('falls back to the main window when the active auxiliary document unregisters', () => {
    const mainRoot = fakeRoot()
    stubDocument(mainRoot)
    register(globalThis.document)
    const auxDocument = register(fakeDocument('aux', fakeRoot()))
    setActiveWorkbenchDocument(auxDocument)

    const auxRegistration = registrations.pop()
    auxRegistration?.dispose()

    expect(monacoWorkbenchLayoutService.activeContainer).toBe(mainRoot)
    expect(monacoWorkbenchLayoutService.containers).toEqual([mainRoot])
  })
})
