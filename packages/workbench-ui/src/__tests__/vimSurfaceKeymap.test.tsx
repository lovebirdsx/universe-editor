/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Surface keymap chain: registration `keymap` + sidecar contributions are concatenated
 *  per surface id, keep a stable reference while unchanged, and vanish on dispose.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import {
  __resetVimSurfacesForTests,
  getActiveVimSurface,
  registerVimSurface,
  registerVimSurfaceKeymap,
  useVimSurface,
  useVimSurfaceKeymap,
} from '../keybinding/vim/vimSurfaceRegistry.js'
import type { IVimKeymapEntry, IVimSurfaceRegistration } from '../keybinding/vim/vimTypes.js'

afterEach(() => {
  cleanup()
  __resetVimSurfacesForTests()
  document.body.innerHTML = ''
})

const A: readonly IVimKeymapEntry[] = [{ id: 'a', keys: ['/'], command: 'cmd.a' }]
const B: readonly IVimKeymapEntry[] = [{ id: 'b', keys: ['?'], command: 'cmd.b' }]
const C: readonly IVimKeymapEntry[] = [{ id: 'c', keys: ['n'], command: 'cmd.c' }]

function focusedList(
  id = 'list-1',
  extra: Partial<IVimSurfaceRegistration> = {},
): { el: HTMLElement; dispose(): void } {
  const el = document.createElement('div')
  el.tabIndex = 0
  document.body.appendChild(el)
  const registration = registerVimSurface({
    id,
    kind: 'list',
    getElement: () => el,
    getSurfaceKey: () => `list:${id}`,
    defaultMode: 'normal',
    actions: {},
    ...extra,
  })
  el.focus()
  return { el, dispose: () => registration.dispose() }
}

const keymapOf = () => getActiveVimSurface(document)?.keymap

describe('vim surface keymap chain', () => {
  it('is empty without any source, and always the same empty array', () => {
    focusedList()
    const first = keymapOf()
    expect(first).toEqual([])
    expect(keymapOf()).toBe(first)
  })

  it('returns the registration keymap itself when it is the only source', () => {
    focusedList('list-1', { keymap: A })
    expect(keymapOf()).toBe(A)
  })

  it('returns a lone sidecar contribution as is', () => {
    focusedList()
    registerVimSurfaceKeymap('list-1', () => B)
    expect(keymapOf()).toBe(B)
  })

  it('concatenates registration and sidecar sources in registration order', () => {
    focusedList('list-1', { keymap: A })
    registerVimSurfaceKeymap('list-1', () => B)
    registerVimSurfaceKeymap('list-1', () => C)
    expect(keymapOf()?.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps a stable merged reference while the sources are unchanged', () => {
    focusedList('list-1', { keymap: A })
    registerVimSurfaceKeymap('list-1', () => B)
    const first = keymapOf()
    expect(keymapOf()).toBe(first)
  })

  it('builds a new merged array when a source array is replaced', () => {
    let current = B
    focusedList('list-1', { keymap: A })
    registerVimSurfaceKeymap('list-1', () => current)
    const first = keymapOf()
    current = C
    const next = keymapOf()
    expect(next).not.toBe(first)
    expect(next?.map((entry) => entry.id)).toEqual(['a', 'c'])
  })

  it('skips a contribution that currently reads as empty', () => {
    focusedList('list-1', { keymap: A })
    registerVimSurfaceKeymap('list-1', () => [])
    expect(keymapOf()).toBe(A)
  })

  it('drops a contribution once it is disposed', () => {
    focusedList('list-1', { keymap: A })
    const first = registerVimSurfaceKeymap('list-1', () => B)
    const second = registerVimSurfaceKeymap('list-1', () => C)
    first.dispose()
    expect(keymapOf()?.map((entry) => entry.id)).toEqual(['a', 'c'])
    second.dispose()
    expect(keymapOf()).toBe(A)
    // disposing twice is harmless
    second.dispose()
    expect(keymapOf()).toBe(A)
  })

  it('does not merge a contribution aimed at a different surface id', () => {
    focusedList('list-1', { keymap: A })
    registerVimSurfaceKeymap('other-surface', () => B)
    expect(keymapOf()).toBe(A)
  })

  it('applies a contribution registered before the surface exists', () => {
    registerVimSurfaceKeymap('list-1', () => B)
    focusedList('list-1')
    expect(keymapOf()).toBe(B)
  })

  it('is not shared between documents', () => {
    const other = document.implementation.createHTMLDocument('other')
    registerVimSurfaceKeymap('list-1', () => B, other)
    focusedList('list-1')
    expect(keymapOf()).toEqual([])
  })

  describe('useVimSurfaceKeymap', () => {
    function Host({
      keymap,
      surfaceId = 'hooked',
    }: {
      keymap: readonly IVimKeymapEntry[]
      surfaceId?: string
    }) {
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
      useVimSurfaceKeymap(surfaceId, keymap)
      return <div ref={ref} tabIndex={0} data-testid="hooked" />
    }

    it('contributes while mounted and removes on unmount', () => {
      const view = render(<Host keymap={B} />)
      view.getByTestId('hooked').focus()
      expect(keymapOf()).toBe(B)
      view.unmount()
      expect(keymapOf()).toBeUndefined()
      expect(getActiveVimSurface(document)).toBeUndefined()
    })

    it('follows a re-rendered keymap without re-registering', () => {
      let setKeymap: (keymap: readonly IVimKeymapEntry[]) => void = () => undefined
      function Stateful() {
        const [keymap, set] = useState<readonly IVimKeymapEntry[]>(B)
        setKeymap = set
        return <Host keymap={keymap} />
      }
      const view = render(<Stateful />)
      view.getByTestId('hooked').focus()
      expect(keymapOf()).toBe(B)
      act(() => setKeymap(C))
      expect(keymapOf()).toBe(C)
    })

    it('does not contribute when the surface id differs', () => {
      const view = render(<Host keymap={B} surfaceId="somebody-else" />)
      view.getByTestId('hooked').focus()
      expect(keymapOf()).toEqual([])
    })
  })
})
