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
    // StrictMode's dry run replaces the first instance once; from the committed
    // mount on, re-renders with equal overrides must keep the live service.
    const live = instances.at(-1)
    const mounts = instances.length
    act(() => {
      fireEvent.click(screen.getByTestId('rerender'))
    })

    expect(instances.length).toBeGreaterThan(mounts)
    expect(instances.slice(mounts).every((instance) => instance === live)).toBe(true)
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
    const before = instances.at(-1)
    rerender(<Probe provider="git" />)

    const after = instances.at(-1)
    expect(after).not.toBe(before)
    expect(after?.get('scmProvider')).toBe('git')
    // The superseded scope was disposed: its keys are cleared, so reads fall
    // through to the parent instead of answering with the stale value.
    expect(before?.get('scmProvider')).toBeUndefined()
    parent.dispose()
  })
})
