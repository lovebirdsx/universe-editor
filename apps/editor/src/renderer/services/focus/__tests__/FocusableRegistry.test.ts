/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IFocusableElement } from '@universe-editor/platform'
import { FocusableRegistry } from '../FocusableRegistry.js'

const el = (name: string): IFocusableElement => ({ focus() {}, name }) as never

describe('FocusableRegistry', () => {
  it('resolves the view’s own registration', () => {
    const registry = new FocusableRegistry()
    const tree = el('tree')
    registry.register('v', () => tree)
    expect(registry.get('v')?.()).toBe(tree)
  })

  it('returns undefined when nothing is registered', () => {
    expect(new FocusableRegistry().get('v')).toBeUndefined()
  })

  // The whole point of the fallback tier: views that contribute no focusable
  // content (MCP Servers, Output) would otherwise leave focus on the Part, so
  // they never entered the focus history and could not be switched back to.
  it('falls back to the container body when the view registers nothing', () => {
    const registry = new FocusableRegistry()
    const body = el('body')
    registry.register('v', () => body, { fallback: true })
    expect(registry.get('v')?.()).toBe(body)
  })

  it('prefers the view’s own target over the fallback', () => {
    const registry = new FocusableRegistry()
    const tree = el('tree')
    const body = el('body')
    registry.register('v', () => body, { fallback: true })
    registry.register('v', () => tree)
    expect(registry.get('v')?.()).toBe(tree)
  })

  // Resolution is per-call, not per-registration: Timeline and Commit Changes
  // register a tree that only exists once their content loads, and report null
  // until then.
  it('falls back while the primary target has not mounted yet', () => {
    const registry = new FocusableRegistry()
    const body = el('body')
    const tree = el('tree')
    let mounted: IFocusableElement | null = null
    registry.register('v', () => body, { fallback: true })
    registry.register('v', () => mounted)

    expect(registry.get('v')?.()).toBe(body)
    mounted = tree
    expect(registry.get('v')?.()).toBe(tree)
  })

  it('keeps the fallback alive when the primary registration is disposed', () => {
    const registry = new FocusableRegistry()
    const body = el('body')
    const tree = el('tree')
    registry.register('v', () => body, { fallback: true })
    const primary = registry.register('v', () => tree)

    primary.dispose()
    expect(registry.get('v')?.()).toBe(body)
  })

  it('disposing the fallback leaves the primary registration intact', () => {
    const registry = new FocusableRegistry()
    const tree = el('tree')
    const fallback = registry.register('v', () => el('body'), { fallback: true })
    registry.register('v', () => tree)

    fallback.dispose()
    expect(registry.get('v')?.()).toBe(tree)
  })

  it('fires onDidChange for both tiers', () => {
    const registry = new FocusableRegistry()
    const fired: string[] = []
    registry.onDidChange((id) => fired.push(id))
    registry.register('a', () => null, { fallback: true })
    registry.register('b', () => null)
    expect(fired).toEqual(['a', 'b'])
  })
})

describe('FocusableRegistry — focus handover to a late primary', () => {
  afterEach(() => vi.unstubAllGlobals())

  const body = () => ({ focus: vi.fn(), contains: () => false })
  const tree = () => ({ focus: vi.fn() })

  it('focuses a primary that registers while its view’s fallback holds focus', () => {
    const registry = new FocusableRegistry()
    const b = body()
    registry.register('v', () => b as never, { fallback: true })
    vi.stubGlobal('document', { activeElement: b })

    const t = tree()
    registry.register('v', () => t as never)

    expect(t.focus).toHaveBeenCalledTimes(1)
    expect(b.focus).not.toHaveBeenCalled()
  })

  it('leaves focus alone when focus is not on the fallback', () => {
    const registry = new FocusableRegistry()
    registry.register('v', () => body() as never, { fallback: true })
    const elsewhere = { focus: vi.fn() }
    vi.stubGlobal('document', { activeElement: elsewhere })

    const t = tree()
    registry.register('v', () => t as never)

    expect(t.focus).not.toHaveBeenCalled()
  })

  it('treats a descendant of the fallback as the view holding focus', () => {
    const registry = new FocusableRegistry()
    const child = { focus: vi.fn() }
    const b = { focus: vi.fn(), contains: (n: unknown) => n === child }
    registry.register('v', () => b as never, { fallback: true })
    vi.stubGlobal('document', { activeElement: child })

    const t = tree()
    registry.register('v', () => t as never)

    expect(t.focus).toHaveBeenCalledTimes(1)
  })

  it('scopes the handover to the same view id', () => {
    const registry = new FocusableRegistry()
    const b = body()
    registry.register('a', () => b as never, { fallback: true })
    vi.stubGlobal('document', { activeElement: b })

    const t = tree()
    registry.register('b', () => t as never)

    expect(t.focus).not.toHaveBeenCalled()
  })

  it('never hands focus on fallback registration or when the primary resolves null', () => {
    const registry = new FocusableRegistry()
    const b = body()
    registry.register('v', () => b as never, { fallback: true })
    vi.stubGlobal('document', { activeElement: b })

    registry.register('v', () => null)
    const t = tree()
    registry.register('w', () => t as never, { fallback: true })

    expect(t.focus).not.toHaveBeenCalled()
    expect(b.focus).not.toHaveBeenCalled()
  })
})
