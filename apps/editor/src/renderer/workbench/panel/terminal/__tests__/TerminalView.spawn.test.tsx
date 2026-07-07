/*---------------------------------------------------------------------------------------------
 *  Regression test for TerminalView auto-spawn behavior.
 *
 *  The view spawns an initial terminal only on the very first mount when none
 *  exist. Once mounted, closing the last terminal must NOT auto-respawn one —
 *  the prior bug respawned a terminal whenever the list dropped to empty after a
 *  restored session, because didInit was only set in the create branch.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { ILayoutService, PartId, observableValue } from '@universe-editor/platform'
import { IWorkspaceService } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import { ServicesContext } from '../../../useService.js'
import { TerminalView } from '../TerminalView.js'

// Stub the heavy xterm-backed instance and file-open hooks — this test only
// cares about TerminalView's spawn decisions, not real terminal rendering.
vi.mock('../TerminalInstance.js', () => ({
  TerminalInstance: () => <div data-testid="terminal-instance-stub" />,
}))

vi.mock('../useTerminalOpenFile.js', () => ({
  useResolveTerminalFile: () => async () => null,
  useOpenTerminalFile: () => () => {},
}))

function makeManager(initial: readonly string[]) {
  const panel = observableValue<readonly { id: string }[]>(
    'test.panel',
    initial.map((id) => ({ id })),
  )
  const groups = observableValue<readonly { id: string; terminals: readonly string[] }[]>(
    'test.groups',
    initial.length > 0 ? [{ id: 'g0', terminals: initial }] : [],
  )
  const activeGroupId = observableValue<string | null>('test.ag', initial.length > 0 ? 'g0' : null)
  const activeId = observableValue<string | null>('test.at', initial[0] ?? null)
  const newTerminal = vi.fn(async () => {
    const id = `t${panel.get().length}`
    panel.set([...panel.get(), { id }], undefined)
    groups.set([{ id: 'g0', terminals: panel.get().map((p) => p.id) }], undefined)
    activeId.set(id, undefined)
    activeGroupId.set('g0', undefined)
    return id
  })

  const manager = {
    _serviceBrand: undefined,
    panelTerminals: panel,
    terminalGroups: groups,
    activeGroupId,
    activeTerminalId: activeId,
    newTerminal,
  }

  const setPanel = (ids: readonly string[]) => {
    panel.set(
      ids.map((id) => ({ id })),
      undefined,
    )
    groups.set(ids.length > 0 ? [{ id: 'g0', terminals: ids }] : [], undefined)
    if (!ids.includes(activeId.get() ?? '')) activeId.set(ids[0] ?? null, undefined)
  }

  return { manager, newTerminal, setPanel }
}

function renderView(manager: unknown) {
  const workspace = { current: { folder: { fsPath: '/work' } } }
  const visible = observableValue('test.layout.visible', {
    [PartId.ActivityBar]: true,
    [PartId.SideBar]: true,
    [PartId.SecondarySideBar]: false,
    [PartId.EditorArea]: true,
    [PartId.Panel]: true,
    [PartId.StatusBar]: true,
  })
  const layout = {
    visible,
  }
  const map = new Map<unknown, unknown>([
    [ITerminalManagerService, manager],
    [IWorkspaceService, workspace],
    [ILayoutService, layout],
  ])
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => map.get(id) }),
  }
  return render(
    <ServicesContext.Provider value={container as never}>
      <TerminalView />
    </ServicesContext.Provider>,
  )
}

describe('TerminalView auto-spawn', () => {
  afterEach(() => cleanup())

  it('spawns one terminal when mounted empty', async () => {
    const h = makeManager([])
    await act(async () => {
      renderView(h.manager)
    })
    expect(h.newTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not spawn when mounted with restored terminals', async () => {
    const h = makeManager(['t-restored'])
    await act(async () => {
      renderView(h.manager)
    })
    expect(h.newTerminal).not.toHaveBeenCalled()
  })

  it('does NOT respawn after the last restored terminal is closed', async () => {
    const h = makeManager(['t-restored'])
    await act(async () => {
      renderView(h.manager)
    })
    // User closes the last terminal — list drops to empty.
    await act(async () => {
      h.setPanel([])
    })
    expect(h.newTerminal).not.toHaveBeenCalled()
  })
})
