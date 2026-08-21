/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useGitGraphAutoRefresh integration: SCM changes → gated debounced revalidate.
 *
 *  Manual refreshes (toolbar button, repo switch, branch-filter change, first
 *  open) call load()/revalidate() directly — they never route through this hook —
 *  so the visibility gate below only affects SCM-driven passive refreshes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { observableValue } from '@universe-editor/platform'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { useGitGraphAutoRefresh } from '../useGitGraphAutoRefresh.js'

const DEBOUNCE = 500

function makeScm() {
  const resources = observableValue('test.resources', [])
  const count = observableValue<number | undefined>('test.count', undefined)
  const group = {
    handle: 0,
    id: 'changes',
    parentId: undefined,
    label: observableValue('test.groupLabel', 'Changes'),
    hideWhenEmpty: observableValue('test.hideWhenEmpty', false),
    resources,
  }
  const sourceControl = {
    handle: 1,
    id: 'git',
    label: 'git',
    rootUri: '/repo',
    inputValue: observableValue('test.input', ''),
    inputPlaceholder: observableValue('test.placeholder', ''),
    count,
    acceptCommand: observableValue('test.accept', undefined),
    acceptActions: observableValue('test.acceptActions', undefined),
    groups: observableValue('test.groups', [group]),
  }
  const scm = {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', [sourceControl]),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService
  return { scm, count }
}

describe('useGitGraphAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not revalidate on SCM changes while hidden', () => {
    const { scm, count } = makeScm()
    const revalidate = vi.fn()
    renderHook(() => useGitGraphAutoRefresh(scm, false, revalidate, DEBOUNCE))

    act(() => {
      count.set(1, undefined)
    })
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE * 10)
    })
    expect(revalidate).not.toHaveBeenCalled()
  })

  it('revalidates exactly once on re-show, collapsing multiple hidden changes', () => {
    const { scm, count } = makeScm()
    const revalidate = vi.fn()
    const { rerender } = renderHook(
      ({ visible }) => useGitGraphAutoRefresh(scm, visible, revalidate, DEBOUNCE),
      { initialProps: { visible: false } },
    )

    act(() => {
      count.set(1, undefined)
      count.set(2, undefined)
      count.set(3, undefined)
    })
    expect(revalidate).not.toHaveBeenCalled()

    rerender({ visible: true })
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE - 1)
    })
    expect(revalidate).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(revalidate).toHaveBeenCalledTimes(1)
  })

  it('keeps the debounce while visible (behaviour unchanged)', () => {
    const { scm, count } = makeScm()
    const revalidate = vi.fn()
    renderHook(() => useGitGraphAutoRefresh(scm, true, revalidate, DEBOUNCE))

    act(() => {
      count.set(1, undefined)
      count.set(2, undefined)
    })
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE - 1)
    })
    expect(revalidate).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(revalidate).toHaveBeenCalledTimes(1)
  })

  it('skips the initial autorun run so first-open load is not double-triggered', () => {
    const { scm } = makeScm()
    const revalidate = vi.fn()
    renderHook(() => useGitGraphAutoRefresh(scm, true, revalidate, DEBOUNCE))
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE * 10)
    })
    expect(revalidate).not.toHaveBeenCalled()
  })
})
