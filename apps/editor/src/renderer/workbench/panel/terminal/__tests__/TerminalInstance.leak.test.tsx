/*---------------------------------------------------------------------------------------------
 *  Regression: a mounted TerminalInstance must not surface its useEffect-owned
 *  Disposables as leaks, and unmounting a view must NOT dispose the persistent
 *  xterm holder (it outlives the view; only a process exit releases it).
 *
 *  The xterm instance + its terminal-level subscriptions now live in
 *  TerminalXtermService (see TerminalXtermService.test.ts). The component only
 *  owns: the manager.onFocusRequest subscription (markAsSingleton, so the leak
 *  tracker ignores it mid-mount), a ResizeObserver and DOM focus listeners.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  DisposableTracker,
  Emitter,
  IContextKeyService,
  setDisposableTracker,
  toDisposable,
} from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import { ITerminalXtermService } from '../../../../services/terminal/TerminalXtermService.js'
import { ServicesContext } from '../../../useService.js'

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface Tracked {
  focusDisposed: boolean
  holderDisposed: boolean
  saveScrollCalls: number
  wrapperRemoved: boolean
}

function makeHolder(tracked: Tracked) {
  const wrapper = document.createElement('div')
  const onDidChangeSelection = new Emitter<void>()
  const origRemove = wrapper.remove.bind(wrapper)
  wrapper.remove = () => {
    tracked.wrapperRemoved = true
    origRemove()
  }
  return {
    term: {},
    wrapper,
    onDidChangeSelection: onDidChangeSelection.event,
    setLinkHandlers() {},
    reattachTo(host: HTMLElement) {
      host.appendChild(wrapper)
    },
    fit() {},
    scheduleFit() {},
    saveScroll() {
      tracked.saveScrollCalls++
    },
    restoreScroll() {},
    focus() {},
    hasSelection() {
      return false
    },
    async copy() {},
    async paste() {},
    dispose() {
      tracked.holderDisposed = true
    },
  }
}

function makeServices(tracked: Tracked) {
  const holder = makeHolder(tracked)

  const contextKeyService = { _serviceBrand: undefined, set: () => {} }

  const manager = {
    _serviceBrand: undefined,
    onFocusRequest: () =>
      toDisposable(() => {
        tracked.focusDisposed = true
      }),
  }

  const xtermService = {
    _serviceBrand: undefined,
    acquire: () => holder,
    get: () => holder,
    release: () => {},
  }

  const map = new Map<unknown, unknown>([
    [IContextKeyService, contextKeyService],
    [ITerminalManagerService, manager],
    [ITerminalXtermService, xtermService],
  ])
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => map.get(id) }),
  }

  return { container, holder }
}

async function renderInstance(tracked: Tracked) {
  const { container } = makeServices(tracked)
  let unmount!: () => void
  const { TerminalInstance } = await import('../TerminalInstance.js')
  await act(async () => {
    ;({ unmount } = render(
      <ServicesContext.Provider value={container as never}>
        <TerminalInstance
          id="t1"
          active
          cwd="/tmp"
          resolveFile={async () => null}
          openFile={() => {}}
        />
      </ServicesContext.Provider>,
    ))
  })
  return { unmount }
}

describe('TerminalInstance disposable hygiene', () => {
  const originalRO = globalThis.ResizeObserver

  beforeEach(() => {
    globalThis.ResizeObserver = FakeResizeObserver as never
  })

  afterEach(() => {
    cleanup()
    setDisposableTracker(null)
    globalThis.ResizeObserver = originalRO
  })

  it('does not report its useEffect-owned subscriptions as leaks while mounted', async () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    const tracked: Tracked = {
      focusDisposed: false,
      holderDisposed: false,
      saveScrollCalls: 0,
      wrapperRemoved: false,
    }
    await renderInstance(tracked)

    const report = tracker.computeLeakingDisposables()
    expect(report?.details ?? '').not.toContain('TerminalInstance')
  })

  it('disposes its own subscriptions but keeps the holder alive on unmount', async () => {
    const tracked: Tracked = {
      focusDisposed: false,
      holderDisposed: false,
      saveScrollCalls: 0,
      wrapperRemoved: false,
    }
    const { unmount } = await renderInstance(tracked)

    await act(async () => {
      unmount()
    })

    expect(tracked.focusDisposed).toBe(true)
    expect(tracked.saveScrollCalls).toBe(1)
    expect(tracked.wrapperRemoved).toBe(true)
    // The holder outlives the view — only a process exit releases it.
    expect(tracked.holderDisposed).toBe(false)
  })
})
