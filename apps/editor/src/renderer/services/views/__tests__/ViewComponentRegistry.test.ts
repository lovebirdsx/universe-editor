import { afterEach, describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { ViewRegistry } from '@universe-editor/platform'
import { ViewComponentRegistry, registerViewWithComponent } from '../ViewComponentRegistry.js'

// Plain placeholder components — these tests exercise registry wiring only and
// never render, so no DOM/React runtime is required (renderer-node project).
const CompA = (() => null) as ComponentType
const CompB = (() => null) as ComponentType

describe('registerViewWithComponent', () => {
  const disposables: { dispose(): void }[] = []

  afterEach(() => {
    while (disposables.length) disposables.pop()!.dispose()
  })

  it('registers the descriptor and binds its component under a key derived from the view id', () => {
    disposables.push(
      registerViewWithComponent(
        {
          id: 'test.view.single',
          name: 'Single',
          containerId: 'test.container',
          order: 1,
        },
        CompA,
      ),
    )

    const descriptor = ViewRegistry.getView('test.view.single')
    expect(descriptor).toBeDefined()
    expect(descriptor?.componentKey).toBe('test.view.single')
    expect(ViewComponentRegistry.get('test.view.single')).toBe(CompA)
  })

  it('resolves to undefined for an id that was never registered (explicit, not a blank view)', () => {
    expect(ViewComponentRegistry.get('test.view.missing')).toBeUndefined()
  })

  it('dispose unregisters both the descriptor and the component binding', () => {
    const reg = registerViewWithComponent(
      {
        id: 'test.view.disposed',
        name: 'Disposed',
        containerId: 'test.container',
        order: 1,
      },
      CompB,
    )
    expect(ViewRegistry.getView('test.view.disposed')).toBeDefined()
    expect(ViewComponentRegistry.get('test.view.disposed')).toBe(CompB)

    reg.dispose()
    expect(ViewRegistry.getView('test.view.disposed')).toBeUndefined()
    expect(ViewComponentRegistry.get('test.view.disposed')).toBeUndefined()
  })
})
