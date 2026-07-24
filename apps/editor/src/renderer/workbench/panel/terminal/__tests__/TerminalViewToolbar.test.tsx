/*---------------------------------------------------------------------------------------------
 *  Tests for TerminalViewToolbar's shell-profile menu: loading / empty /
 *  populated states and the per-profile spawn path.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ICommandService, observableValue } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import type { ITerminalProfile } from '../../../../../shared/ipc/terminalService.js'
import { ServicesContext } from '../../../useService.js'
import { TerminalViewToolbar } from '../TerminalViewToolbar.js'

function makeManager(initialProfiles: readonly ITerminalProfile[] | null) {
  const profiles = observableValue<readonly ITerminalProfile[] | null>(
    'test.profiles',
    initialProfiles,
  )
  const newTerminal = vi.fn(async () => 't0')
  const refreshProfiles = vi.fn(async () => {})
  const manager = {
    _serviceBrand: undefined,
    panelTerminals: observableValue('test.panel', [] as readonly { id: string }[]),
    activeTerminalId: observableValue<string | null>('test.at', null),
    profiles,
    newTerminal,
    refreshProfiles,
  }
  return { manager, newTerminal, refreshProfiles, profiles }
}

function renderToolbar(manager: unknown) {
  const commandService = { executeCommand: vi.fn() }
  const map = new Map<unknown, unknown>([
    [ITerminalManagerService, manager],
    [ICommandService, commandService],
  ])
  const container = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => map.get(id) }),
  }
  return render(
    <ServicesContext.Provider value={container as never}>
      <TerminalViewToolbar />
    </ServicesContext.Provider>,
  )
}

const pwsh: ITerminalProfile = {
  profileName: 'PowerShell',
  path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  isDefault: true,
  isAutoDetected: true,
}
const gitBash: ITerminalProfile = {
  profileName: 'Git Bash',
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  isDefault: false,
  isAutoDetected: true,
}

describe('TerminalViewToolbar profile menu', () => {
  afterEach(() => cleanup())

  async function openMenu(h: ReturnType<typeof makeManager>, ui: ReturnType<typeof renderToolbar>) {
    await act(async () => {
      fireEvent.click(ui.getByTestId('terminal-profile-menu-toggle'))
    })
    expect(h.refreshProfiles).toHaveBeenCalled()
  }

  it('prefetches profile detection on mount', async () => {
    const h = makeManager(null)
    await act(async () => {
      renderToolbar(h.manager)
    })
    expect(h.refreshProfiles).toHaveBeenCalled()
  })

  it('shows a loading placeholder while profiles are null', async () => {
    const h = makeManager(null)
    const ui = renderToolbar(h.manager)
    await openMenu(h, ui)
    expect(ui.getByText('Detecting shells…')).toBeTruthy()
  })

  it('shows an empty placeholder when no profile was detected', async () => {
    const h = makeManager([])
    const ui = renderToolbar(h.manager)
    await openMenu(h, ui)
    expect(ui.getByText('No profiles detected')).toBeTruthy()
  })

  it('renders every profile and marks the default one', async () => {
    const h = makeManager([pwsh, gitBash])
    const ui = renderToolbar(h.manager)
    await openMenu(h, ui)
    expect(ui.getByTestId('terminal-profile-item-PowerShell').textContent).toContain('(Default)')
    expect(ui.getByTestId('terminal-profile-item-Git Bash').textContent).toBe('Git Bash')
  })

  it('spawns a new terminal with the clicked profile', async () => {
    const h = makeManager([pwsh, gitBash])
    const ui = renderToolbar(h.manager)
    await openMenu(h, ui)
    await act(async () => {
      fireEvent.click(ui.getByTestId('terminal-profile-item-Git Bash'))
    })
    expect(h.newTerminal).toHaveBeenCalledWith({ profile: 'Git Bash', target: 'panel' })
  })

  it('updates the menu when profiles refresh', async () => {
    const h = makeManager(null)
    const ui = renderToolbar(h.manager)
    await openMenu(h, ui)
    expect(ui.getByText('Detecting shells…')).toBeTruthy()
    await act(async () => {
      h.profiles.set([pwsh], undefined)
    })
    expect(ui.getByTestId('terminal-profile-item-PowerShell')).toBeTruthy()
  })
})
