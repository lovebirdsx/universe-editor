/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useTransformFreePlacement — the handshake that keeps a `fixed` panel from
 *  measuring against a surface Floating UI has not finished positioning yet.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCallback, useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { AnchoredSurfacePositionedContext } from '../overlay/anchoredSurfaceContext.js'
import { useTransformFreePlacement } from '../overlay/useTransformFreePlacement.js'

function Panel({ onCompute }: { onCompute: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const compute = useCallback(() => {
    onCompute()
    return { top: 42, left: 7 }
  }, [onCompute])
  const { style } = useTransformFreePlacement(ref, compute)
  return <div ref={ref} data-testid="panel" style={style} />
}

describe('useTransformFreePlacement', () => {
  afterEach(cleanup)

  it('measures immediately with no surface above it', () => {
    const onCompute = vi.fn()
    render(<Panel onCompute={onCompute} />)

    // The default context value is `true`: a panel portalled straight to the
    // body (the SCM title overflow menu) has no async positioning to wait for.
    expect(onCompute).toHaveBeenCalled()
    expect(screen.getByTestId('panel').style.visibility).toBe('')
  })

  it('holds off measuring until the enclosing surface reports itself positioned', () => {
    const onCompute = vi.fn()
    const { rerender } = render(
      <AnchoredSurfacePositionedContext value={false}>
        <Panel onCompute={onCompute} />
      </AnchoredSurfacePositionedContext>,
    )

    // Measuring here would read the parent row's rect and this panel's own
    // containing-block origin off a surface still parked at `translate(0, 0)`,
    // and nothing re-fires once the real transform lands.
    expect(onCompute).not.toHaveBeenCalled()
    expect(screen.getByTestId('panel').style.visibility).toBe('hidden')

    act(() => {
      rerender(
        <AnchoredSurfacePositionedContext value={true}>
          <Panel onCompute={onCompute} />
        </AnchoredSurfacePositionedContext>,
      )
    })

    expect(onCompute).toHaveBeenCalled()
    expect(screen.getByTestId('panel').style.visibility).toBe('')
  })

  it('leaves resize and scroll unwatched while the surface is unpositioned', () => {
    const onCompute = vi.fn()
    render(
      <AnchoredSurfacePositionedContext value={false}>
        <Panel onCompute={onCompute} />
      </AnchoredSurfacePositionedContext>,
    )

    act(() => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('scroll'))
    })
    expect(onCompute).not.toHaveBeenCalled()
  })
})
