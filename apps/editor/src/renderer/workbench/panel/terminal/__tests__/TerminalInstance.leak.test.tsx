/*---------------------------------------------------------------------------------------------
 *  Regression: a mounted TerminalInstance must not surface its useEffect-owned
 *  Disposables as leaks. The Restart Editor command snapshots the leak tracker
 *  while React is still mounted (before reactRoot.unmount() flushes passive
 *  cleanup), so the live subscriptions created in useEffect — manager.attach,
 *  config.onDidChangeConfiguration, manager.onFocusRequest — appeared as leaks.
 *  They are marked as singletons (the useOwnedTreeModel pattern): the tracker
 *  ignores them, a real unmount still disposes them.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  DisposableTracker,
  IConfigurationService,
  IContextKeyService,
  setDisposableTracker,
  toDisposable,
  type IDisposable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../../useService.js'

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts }
    }
    loadAddon(): void {}
    open(): void {}
    registerLinkProvider(): IDisposable {
      return { dispose() {} }
    }
    onData(): IDisposable {
      return { dispose() {} }
    }
    onSelectionChange(): IDisposable {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler(): void {}
    write(): void {}
    focus(): void {}
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    paste(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

// happy-dom lacks ResizeObserver; xterm-adjacent code in the component uses it.
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface Tracked {
  attachDisposed: boolean
  focusDisposed: boolean
  configDisposed: boolean
}

function makeServices(tracked: Tracked) {
  const configService = {
    _serviceBrand: undefined,
    get: () => 5000,
    onDidChangeConfiguration: () =>
      toDisposable(() => {
        tracked.configDisposed = true
      }),
  }

  const contextKeyService = {
    _serviceBrand: undefined,
    set: () => {},
  }

  const manager = {
    _serviceBrand: undefined,
    attach: () =>
      toDisposable(() => {
        tracked.attachDisposed = true
      }),
    input: () => {},
    resize: () => {},
    onFocusRequest: () =>
      toDisposable(() => {
        tracked.focusDisposed = true
      }),
  }

  // Minimal DI container substitute: useService reads via invokeFunction, so we
  // provide a fake container exposing just that.
  const map = new Map<unknown, unknown>([
    [IConfigurationService, configService],
    [IContextKeyService, contextKeyService],
  ])
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => map.get(id) }),
  }

  return { container, manager }
}

async function renderInstance(tracked: Tracked) {
  const { container, manager } = makeServices(tracked)
  let unmount!: () => void
  const { TerminalInstance } = await import('../TerminalInstance.js')
  await act(async () => {
    ;({ unmount } = render(
      <ServicesContext.Provider value={container as never}>
        <TerminalInstance
          id="t1"
          active
          isDark
          manager={manager as never}
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
      attachDisposed: false,
      focusDisposed: false,
      configDisposed: false,
    }
    await renderInstance(tracked)

    // Restart Editor snapshots leaks with React still mounted.
    const report = tracker.computeLeakingDisposables()
    expect(report?.details ?? '').not.toContain('TerminalInstance')
  })

  it('still disposes those subscriptions on unmount', async () => {
    const tracked: Tracked = {
      attachDisposed: false,
      focusDisposed: false,
      configDisposed: false,
    }
    const { unmount } = await renderInstance(tracked)

    await act(async () => {
      unmount()
    })

    expect(tracked.attachDisposed).toBe(true)
    expect(tracked.focusDisposed).toBe(true)
    expect(tracked.configDisposed).toBe(true)
  })
})
