/*---------------------------------------------------------------------------------------------
 *  useViewScopedContextKey must survive StrictMode's mount → cleanup → mount
 *  rehearsal: the dry run disposes and nulls the service created during render,
 *  and without recreating it the live tree keeps a disposed service whose `view`
 *  key reads fall through to the root service (every ViewTitle `when` fails).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { StrictMode, type ReactNode } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { ContextKeyService, IContextKeyService } from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { useViewScopedContextKey } from '../useViewScopedContextKey.js'

function strictWrapper(root: ContextKeyService) {
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => (id === IContextKeyService ? root : undefined) }),
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StrictMode>
        <ServicesContext.Provider value={container as never}>{children}</ServicesContext.Provider>
      </StrictMode>
    )
  }
}

afterEach(cleanup)

describe('useViewScopedContextKey under StrictMode', () => {
  it('returns a live scoped service carrying the view key after the dry run', () => {
    const root = new ContextKeyService()
    const { result } = renderHook(() => useViewScopedContextKey('workbench.view.explorer'), {
      wrapper: strictWrapper(root),
    })
    expect(result.current.get('view')).toBe('workbench.view.explorer')
  })

  it('applies a later viewId change to the live service', () => {
    const root = new ContextKeyService()
    const { result, rerender } = renderHook(
      ({ viewId }: { viewId: string | undefined }) => useViewScopedContextKey(viewId),
      { wrapper: strictWrapper(root), initialProps: { viewId: 'first' as string | undefined } },
    )
    rerender({ viewId: 'second' })
    expect(result.current.get('view')).toBe('second')
  })
})
