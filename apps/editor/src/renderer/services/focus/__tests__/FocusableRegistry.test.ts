/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
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
