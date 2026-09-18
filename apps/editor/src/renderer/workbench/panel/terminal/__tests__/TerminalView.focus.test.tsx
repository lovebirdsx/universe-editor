/*---------------------------------------------------------------------------------------------
 *  Regression test for TerminalView's focus registration.
 *
 *  The view never called useViewFocusable, so `workbench.view.terminal.main` had
 *  only ViewBody's fallback (a tabIndex=-1 container div) in the FocusableRegistry.
 *  Every focus request routed through LayoutService.focusView — Ctrl+Tab's
 *  switcher, a container-tab click, the recent-targets picker — therefore parked
 *  DOM focus on the container: a focus ring around the whole panel and keystrokes
 *  that never reached the shell. TerminalInstance's own focus effect could not
 *  rescue it, because that one only runs when its `focused` prop flips.
 *
 *  The getter must read the services at *call* time, not from the render snapshot:
 *  focusView polls it across frames, and the user can switch terminal instances in
 *  between. The empty cases (no active terminal, no holder yet) must yield null so
 *  ViewBody's fallback still applies — that is what keeps a terminal-less view
 *  focusable, and therefore in the Ctrl+Tab recency list.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  IFocusableRegistry,
  ILayoutService,
  IWorkspaceService,
  PartId,
  observableValue,
} from '@universe-editor/platform'
import { FocusableRegistry } from '../../../../services/focus/FocusableRegistry.js'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import { ITerminalXtermService } from '../../../../services/terminal/TerminalXtermService.js'
import { ServicesContext } from '../../../useService.js'
import { TerminalView } from '../TerminalView.js'

const VIEW_ID = 'workbench.view.terminal.main'

// Only the registration is under test — the real instance needs a pty and xterm.
vi.mock('../TerminalInstance.js', () => ({
  TerminalInstance: () => <div data-testid="terminal-instance-stub" />,
}))

vi.mock('../useTerminalOpenFile.js', () => ({
  useResolveTerminalFile: () => async () => null,
  useOpenTerminalFile: () => () => {},
}))

function makeHarness(initial: readonly string[]) {
  const panel = observableValue<readonly { id: string }[]>(
    't.panel',
    initial.map((id) => ({ id })),
  )
  const groups = observableValue<readonly { id: string; terminals: readonly string[] }[]>(
    't.groups',
    initial.length > 0 ? [{ id: 'g0', terminals: [...initial] }] : [],
  )
  const activeGroupId = observableValue<string | null>('t.ag', initial.length > 0 ? 'g0' : null)
  const activeId = observableValue<string | null>('t.at', initial[0] ?? null)

  const manager = {
    _serviceBrand: undefined,
    panelTerminals: panel,
    terminalGroups: groups,
    activeGroupId,
    activeTerminalId: activeId,
    initialLoadDone: observableValue('t.loaded', true),
    waitForInitialLoad: () => Promise.resolve(),
    newTerminal: vi.fn(async () => null),
  }

  // Holders appear only once the instance mounted and acquired its xterm, which
  // is exactly the state the getter has to tolerate being absent.
  const holders = new Map<string, { focusElement: HTMLTextAreaElement }>()
  const provide = (id: string): HTMLTextAreaElement => {
    const el = document.createElement('textarea')
    holders.set(id, { focusElement: el })
    return el
  }
  const xtermService = {
    _serviceBrand: undefined,
    get: (id: string) => holders.get(id),
  }

  const registry = new FocusableRegistry()
  const layout = {
    visible: observableValue('t.visible', {
      [PartId.ActivityBar]: true,
      [PartId.SideBar]: true,
      [PartId.SecondarySideBar]: false,
      [PartId.EditorArea]: true,
      [PartId.Panel]: true,
      [PartId.StatusBar]: true,
    }),
  }
  const map = new Map<unknown, unknown>([
    [ITerminalManagerService, manager],
    [ITerminalXtermService, xtermService],
    [IFocusableRegistry, registry],
    [ILayoutService, layout],
    [IWorkspaceService, { current: { folder: { fsPath: '/work' } } }],
  ])
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => map.get(id) }),
  }

  return { container, registry, groups, activeId, provide }
}

function renderView(container: unknown) {
  return render(
    <ServicesContext.Provider value={container as never}>
      <TerminalView />
    </ServicesContext.Provider>,
  )
}

describe('TerminalView focus registration', () => {
  afterEach(() => cleanup())

  it('registers the active terminal textarea as the primary focus target', async () => {
    const h = makeHarness(['t1', 't2'])
    const el = h.provide('t1')
    await act(async () => {
      renderView(h.container)
    })

    const getter = h.registry.get(VIEW_ID)
    expect(getter).toBeDefined()
    expect(getter!()).toBe(el)
  })

  it('resolves the active id at call time, not from the render snapshot', async () => {
    const h = makeHarness(['t1', 't2'])
    h.provide('t1')
    await act(async () => {
      renderView(h.container)
    })
    const getter = h.registry.get(VIEW_ID)!

    const next = h.provide('t2')
    await act(async () => {
      h.activeId.set('t2', undefined)
    })
    expect(getter()).toBe(next)
  })

  it('yields null while the terminal has no xterm yet, so the ViewBody fallback applies', async () => {
    const h = makeHarness(['t1'])
    await act(async () => {
      renderView(h.container)
    })

    expect(h.registry.get(VIEW_ID)!()).toBeNull()
  })

  it('yields null when the active id is not a member of the active group', async () => {
    const h = makeHarness(['t1'])
    h.provide('t1')
    await act(async () => {
      renderView(h.container)
    })
    const getter = h.registry.get(VIEW_ID)!

    await act(async () => {
      h.groups.set([{ id: 'g1', terminals: ['t9'] }], undefined)
    })
    expect(getter()).toBeNull()
  })

  it('drops its registration on unmount', async () => {
    const h = makeHarness(['t1'])
    h.provide('t1')
    let unmount!: () => void
    await act(async () => {
      ;({ unmount } = renderView(h.container))
    })
    expect(h.registry.get(VIEW_ID)).toBeDefined()

    await act(async () => {
      unmount()
    })
    expect(h.registry.get(VIEW_ID)).toBeUndefined()
  })
})
