/*---------------------------------------------------------------------------------------------
 *  CommitChangesViewToolbar — title-bar actions: Open in Graph routes through
 *  the provider's graph reveal bridge with the payload's commitRef; collapse /
 *  expand-all bump the shared signal counters (tree mode only); the overflow
 *  menu toggles tree/list through commitChangesViewState.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandsRegistry,
  ICommandService,
  InstantiationService,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'
import { ServicesContext } from '../../../useService.js'
import { CommitChangesViewToolbar } from '../CommitChangesViewToolbar.js'
import { commitChangesViewState } from '../viewState.js'

const executeCommand = vi.fn(async (..._args: unknown[]) => undefined)

function renderToolbar() {
  const services = new ServiceCollection()
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
  } as never)
  return render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <CommitChangesViewToolbar />
    </ServicesContext.Provider>,
  )
}

function payload(overrides?: Partial<ShowCommitChangesPayload>): ShowCommitChangesPayload {
  return {
    providerId: 'git',
    title: 'a1b2c3d — fix crash',
    commitRef: 'a1b2c3d',
    openExternalCommand: 'git-graph.openFileDiff',
    files: [],
    ...overrides,
  }
}

describe('CommitChangesViewToolbar', () => {
  let gitBridge: IDisposable
  let perforceBridge: IDisposable

  beforeAll(() => {
    gitBridge = CommandsRegistry.registerCommand('_workbench.openGitGraph', () => undefined)
    perforceBridge = CommandsRegistry.registerCommand(
      '_workbench.openPerforceGraph',
      () => undefined,
    )
  })
  afterAll(() => {
    gitBridge.dispose()
    perforceBridge.dispose()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    commitChangesViewState._resetForTests()
  })
  afterEach(() => {
    cleanup()
    commitChangesViewState._resetForTests()
  })

  it('renders nothing before any payload has been shown', () => {
    const { container } = renderToolbar()
    expect(container.innerHTML).toBe('')
  })

  it('Open in Graph executes the git reveal bridge with the commitRef', () => {
    renderToolbar()
    act(() => {
      commitChangesViewState.show(payload())
    })

    fireEvent.click(screen.getByTestId('scm-title-action-commitChanges.openInGraph'))
    expect(executeCommand).toHaveBeenCalledWith('_workbench.openGitGraph', 'a1b2c3d')
  })

  it('Open in Graph executes the perforce reveal bridge with the changelist id', () => {
    renderToolbar()
    act(() => {
      commitChangesViewState.show(
        payload({ providerId: 'perforce', commitRef: '12345', title: 'Changelist 12345' }),
      )
    })

    fireEvent.click(screen.getByTestId('scm-title-action-commitChanges.openInGraph'))
    expect(executeCommand).toHaveBeenCalledWith('_workbench.openPerforceGraph', '12345')
  })

  it('Open in Graph reveals the first-picked commit for a compare payload', () => {
    renderToolbar()
    act(() => {
      commitChangesViewState.show(
        payload({
          title: 'a1b2c3d ↔ e5f6g7h',
          commitRef: 'a1b2c3d..e5f6g7h',
          metadata: { compareRefs: { from: 'a1b2c3d', to: 'e5f6g7h' } },
        }),
      )
    })

    fireEvent.click(screen.getByTestId('scm-title-action-commitChanges.openInGraph'))
    expect(executeCommand).toHaveBeenCalledWith('_workbench.openGitGraph', 'a1b2c3d')
  })

  it('hides Open in Graph when the provider has no graph command', () => {
    renderToolbar()
    act(() => {
      commitChangesViewState.show(payload({ providerId: 'svn' }))
    })

    expect(screen.queryByTestId('scm-title-action-commitChanges.openInGraph')).toBeNull()
    // The remaining toolbar (fold buttons + overflow) still renders.
    expect(screen.getByTestId('scm-title-action-commitChanges.collapseAll')).toBeTruthy()
  })

  it('collapse / expand-all buttons bump the shared signals in tree mode', () => {
    renderToolbar()
    act(() => {
      commitChangesViewState.show(payload())
    })

    fireEvent.click(screen.getByTestId('scm-title-action-commitChanges.collapseAll'))
    expect(commitChangesViewState.collapseAllSignal.get()).toBe(1)
    fireEvent.click(screen.getByTestId('scm-title-action-commitChanges.expandAll'))
    expect(commitChangesViewState.expandAllSignal.get()).toBe(1)
  })

  it('hides the fold buttons in list mode', () => {
    renderToolbar()
    act(() => {
      commitChangesViewState.setViewMode('list')
      commitChangesViewState.show(payload())
    })

    expect(screen.queryByTestId('scm-title-action-commitChanges.collapseAll')).toBeNull()
    expect(screen.queryByTestId('scm-title-action-commitChanges.expandAll')).toBeNull()
  })

  it('overflow menu toggles between View as List and View as Tree', () => {
    renderToolbar()
    act(() => {
      commitChangesViewState.show(payload())
    })

    fireEvent.click(screen.getByLabelText('More Actions...'))
    fireEvent.click(screen.getByText('View as List'))
    expect(commitChangesViewState.viewMode.get()).toBe('list')

    fireEvent.click(screen.getByLabelText('More Actions...'))
    fireEvent.click(screen.getByText('View as Tree'))
    expect(commitChangesViewState.viewMode.get()).toBe('tree')
  })
})
