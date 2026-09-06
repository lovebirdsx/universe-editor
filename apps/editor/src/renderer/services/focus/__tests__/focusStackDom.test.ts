/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { PartId } from '@universe-editor/platform'
import { closestAttr, closestPartId } from '../FocusStackService.js'

/** Minimal ancestor chain: leaf first, each entry's attributes. */
function chain(...levels: Record<string, string>[]): HTMLElement {
  let parent: HTMLElement | null = null
  for (const attrs of [...levels].reverse()) {
    const el = {
      getAttribute: (name: string) => attrs[name] ?? null,
      parentElement: parent,
    } as unknown as HTMLElement
    parent = el
  }
  return parent as HTMLElement
}

describe('closestPartId', () => {
  // Regression: Parts spell their testid all-lowercase (`part-sidebar`) while
  // PartId is camelCase (`sideBar`). A case-sensitive lookup rejected four of
  // the six Parts, so `_onFocusChange` bailed out and the focus stack stayed
  // permanently empty — which in turn left the Ctrl+Tab MRU listing views in
  // registration order, never by recency.
  it.each([
    ['part-sidebar', PartId.SideBar],
    ['part-secondarysidebar', PartId.SecondarySideBar],
    ['part-activitybar', PartId.ActivityBar],
    ['part-statusbar', PartId.StatusBar],
    ['part-editorArea', PartId.EditorArea],
    ['part-panel', PartId.Panel],
  ])('resolves %s regardless of casing', (testId, expected) => {
    expect(closestPartId(chain({ 'data-testid': testId }))).toBe(expected)
  })

  it('walks past a view root that carries its own data-testid', () => {
    // The Search view's input sits under `data-testid="search-view"`, which used
    // to shadow the enclosing `part-sidebar`.
    const el = chain(
      {},
      { 'data-testid': 'search-view' },
      { 'data-view-id': 'workbench.view.search.results' },
      { 'data-testid': 'part-sidebar' },
    )
    expect(closestPartId(el)).toBe(PartId.SideBar)
    expect(closestAttr(el, 'data-view-id')).toBe('workbench.view.search.results')
  })

  it('returns undefined when no Part encloses the element', () => {
    expect(closestPartId(chain({}, { 'data-testid': 'floating-thing' }))).toBeUndefined()
  })

  it('ignores a part- testid that names no known Part', () => {
    expect(closestPartId(chain({ 'data-testid': 'part-nonesuch' }))).toBeUndefined()
  })
})

describe('closestAttr', () => {
  it('returns the nearest ancestor value', () => {
    const el = chain({}, { 'data-group-id': '2' }, { 'data-group-id': '0' })
    expect(closestAttr(el, 'data-group-id')).toBe('2')
  })

  it('returns undefined when the attribute is absent from the chain', () => {
    expect(closestAttr(chain({}, {}), 'data-view-id')).toBeUndefined()
  })
})
