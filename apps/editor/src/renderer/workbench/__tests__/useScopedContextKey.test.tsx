/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useScopedContextKey — the guard rail for a failure that is invisible by
 *  construction: disposing a scoped ContextKeyService only clears its keys, so
 *  reads fall through to the parent and every `when` clause silently turns
 *  false. StrictMode's dev-only dry run disposes exactly this, which is why the
 *  naive useMemo spelling looked fine in production and in e2e.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextKeyService, type IScopedContextKeyService } from '@universe-editor/platform'
import { useScopedContextKey } from '../useScopedContextKey.js'

afterEach(() => cleanup())

describe('useScopedContextKey', () => {
  it('returns a live service after StrictMode disposed the dry-run instance', () => {
    const parent = new ContextKeyService()
    const seen: (string | undefined)[] = []

    function Probe() {
      const scoped = useScopedContextKey(parent, { scmProvider: 'perforce' })
      seen.push(scoped.get('scmProvider') as string | undefined)
      return <span data-testid="value">{String(scoped.get('scmProvider'))}</span>
    }

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    )

    expect(screen.getByTestId('value').textContent).toBe('perforce')
    // Every render — dry run included — saw a service that still had its keys.
    expect(seen.every((v) => v === 'perforce')).toBe(true)
    parent.dispose()
  })

  it('keeps one service across re-renders that pass an equal overrides literal', () => {
    const parent = new ContextKeyService()
    const instances: IScopedContextKeyService[] = []

    function Probe() {
      const [, force] = useState(0)
      // A fresh object literal every render: the hook compares by content, so
      // callers owe it no useMemo.
      instances.push(useScopedContextKey(parent, { scmProvider: 'perforce' }))
      return (
        <button data-testid="rerender" onClick={() => force((n) => n + 1)}>
          rerender
        </button>
      )
    }

    render(<Probe />)
    act(() => {
      fireEvent.click(screen.getByTestId('rerender'))
    })

    expect(instances.length).toBeGreaterThan(1)
    expect(new Set(instances).size).toBe(1)
    parent.dispose()
  })

  it('rebuilds when an override value actually changes', () => {
    const parent = new ContextKeyService()
    const instances: IScopedContextKeyService[] = []

    function Probe({ provider }: { provider: string }) {
      instances.push(useScopedContextKey(parent, { scmProvider: provider }))
      return null
    }

    const { rerender } = render(<Probe provider="perforce" />)
    rerender(<Probe provider="git" />)

    expect(new Set(instances).size).toBe(2)
    expect(instances.at(-1)?.get('scmProvider')).toBe('git')
    parent.dispose()
  })
})
