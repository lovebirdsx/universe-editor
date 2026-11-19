/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Surface arbitration: menu > overlay > list > terminal > editor > chrome;
 *  nested elements go innermost; equal candidates go newest.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import {
  __getVimSurfaceCountForTests,
  __hasVimDocumentStateForTests,
  __resetVimSurfacesForTests,
  getActiveVimSurface,
  onDidChangeVimSurfaces,
  registerVimSurface,
  resetVimSequences,
  useVimSurface,
} from '../keybinding/vim/vimSurfaceRegistry.js'
import type { IVimSurfaceRegistration, VimSurfaceKind } from '../keybinding/vim/vimTypes.js'

afterEach(() => {
  cleanup()
  __resetVimSurfacesForTests()
  document.body.innerHTML = ''
})

function element(tag = 'div'): HTMLDivElement {
  const el = document.createElement(tag) as HTMLDivElement
  el.tabIndex = 0
  document.body.appendChild(el)
  return el
}

function surface(
  kind: VimSurfaceKind,
  el: HTMLElement | null,
  key = `${kind}:1`,
  id = `${kind}-surface`,
): IVimSurfaceRegistration {
  return {
    id,
    kind,
    getElement: () => el,
    getSurfaceKey: () => key,
    defaultMode: 'normal',
    actions: {},
  }
}

describe('vimSurfaceRegistry', () => {
  it('returns the focused list surface and its key', () => {
    const el = element()
    registerVimSurface(surface('list', el, 'list:tree'))
    el.focus()
    expect(getActiveVimSurface(document)?.surfaceKey).toBe('list:tree')
  })

  it('ignores a surface that does not contain focus', () => {
    const el = element()
    const other = element()
    registerVimSurface(surface('list', el))
    other.focus()
    expect(getActiveVimSurface(document)).toBeUndefined()
  })

  it('keeps menus active without DOM focus', () => {
    const el = element()
    registerVimSurface(surface('menu', el))
    document.body.focus()
    expect(getActiveVimSurface(document)?.surface.kind).toBe('menu')
  })

  it('prefers a menu over a focused list', () => {
    const listEl = element()
    const menuEl = element()
    registerVimSurface(surface('list', listEl, 'list:1'))
    registerVimSurface(surface('menu', menuEl, 'menu:1'))
    listEl.focus()
    expect(getActiveVimSurface(document)?.surfaceKey).toBe('menu:1')
  })

  it('prefers an overlay over a list that contains it', () => {
    const listEl = element()
    const overlayEl = element()
    listEl.appendChild(overlayEl)
    registerVimSurface(surface('list', listEl, 'list:1'))
    registerVimSurface(surface('overlay', overlayEl, 'overlay:1'))
    overlayEl.focus()
    expect(getActiveVimSurface(document)?.surfaceKey).toBe('overlay:1')
  })

  it('prefers the innermost surface of the same kind', () => {
    const outer = element()
    const inner = element()
    outer.appendChild(inner)
    registerVimSurface(surface('list', outer, 'list:outer'))
    registerVimSurface(surface('list', inner, 'list:inner'))
    inner.focus()
    expect(getActiveVimSurface(document)?.surfaceKey).toBe('list:inner')
  })

  it('gives each surface its own sequence engine', () => {
    const a = element()
    const b = element()
    registerVimSurface(surface('list', a, 'list:a'))
    registerVimSurface(surface('list', b, 'list:b'))
    a.focus()
    const first = getActiveVimSurface(document)
    expect(first).toBeDefined()
    first!.sequence.feed('2')
    b.focus()
    expect(getActiveVimSurface(document)!.sequence.isPending).toBe(false)
  })

  it('resets every surface sequence on a document', () => {
    const a = element()
    const b = element()
    registerVimSurface(surface('list', a, 'list:a'))
    registerVimSurface(surface('list', b, 'list:b'))
    a.focus()
    const first = getActiveVimSurface(document)!
    first.sequence.setEntries([{ id: 'gg', keys: ['g', 'g'], command: 'x' }])
    first.sequence.feed('g')
    expect(first.sequence.isPending).toBe(true)

    resetVimSequences(document)

    expect(first.sequence.isPending).toBe(false)
    b.focus()
    expect(getActiveVimSurface(document)!.sequence.isPending).toBe(false)
  })

  it('drops the document state when the last listener goes away', () => {
    const subscription = onDidChangeVimSurfaces(document, () => undefined)
    expect(__hasVimDocumentStateForTests(document)).toBe(true)
    subscription.dispose()
    expect(__hasVimDocumentStateForTests(document)).toBe(false)
  })

  it('drops a disposed surface', () => {
    const el = element()
    const registration = registerVimSurface(surface('list', el))
    el.focus()
    expect(__getVimSurfaceCountForTests(document)).toBe(1)
    registration.dispose()
    expect(__getVimSurfaceCountForTests(document)).toBe(0)
    expect(getActiveVimSurface(document)).toBeUndefined()
  })

  it('registers through the React hook and removes on unmount', () => {
    const seen: Array<string | undefined> = []
    function Host() {
      const ref = useRef<HTMLDivElement>(null)
      useVimSurface({
        id: 'hooked',
        kind: 'list',
        focus: 'self',
        getElement: () => ref.current,
        getSurfaceKey: () => 'list:hooked',
        defaultMode: 'normal',
        actions: {},
      })
      return <div ref={ref} tabIndex={0} data-testid="hooked" />
    }
    const view = render(<Host />)
    const el = view.getByTestId('hooked')
    el.focus()
    seen.push(getActiveVimSurface(document)?.surfaceKey)
    view.unmount()
    seen.push(getActiveVimSurface(document)?.surfaceKey)
    expect(seen).toEqual(['list:hooked', undefined])
  })
})
