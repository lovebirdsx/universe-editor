/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'

import {
  MONACO_LAYOUT_SERVICE_ID,
  monacoWorkbenchLayoutService,
} from '../monacoWorkbenchLayoutService.js'

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
    expect(monacoWorkbenchLayoutService.getContainer({ document: {} as Document })).toBe(root)
    expect(monacoWorkbenchLayoutService.containers).toEqual([root])
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
