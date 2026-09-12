/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the reveal → Commit Changes silent follow: revealing a
 *  changelist (the `_workbench.openPerforceGraph` path) pushes its files into
 *  the Commit Changes view with `silent: true` when the view is already in
 *  use, fetches nothing while the view is untouched, and never refetches the
 *  changelist the view already shows.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import {
  PerforceGraphCommands,
  type P4GraphChangeDetailsDto,
  type P4GraphChangeDto,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
  type ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { perforceGraphViewState } from '../../../services/perforceGraph/perforceGraphViewState.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { commitChangesViewState } from '../../scm/commitChanges/viewState.js'
import { _clearGraphPayloadCacheForTests } from '../../scm/commitChanges/graphPayloadCache.js'
import { ServicesContext } from '../../useService.js'
import { ShowCommitChangesAction } from '../../../actions/commitChangesActions.js'
import { PerforceGraphEditor } from '../PerforceGraphEditor.js'

const REPO: P4GraphRepoDto = { root: 'C:/ws/main', name: 'alice-ws' }

function change(id: string, message: string): P4GraphChangeDto {
  return { id, parents: [], author: 'alice', client: 'alice-ws', date: 1, message, body: message }
}

function makeDetails(id: string): P4GraphChangeDetailsDto {
  return {
    id,
    author: 'alice',
    client: 'alice-ws',
    date: 1,
    body: `subject of ${id}`,
    files: [
      {
        status: 'M',
        path: 'depot/main/a.txt',
        oldPath: null,
        depotFile: '//depot/main/a.txt',
        rev: '3',
        localPath: 'C:/ws/main/a.txt',
      },
    ],
  }
}

function makeResult(): P4GraphLoadResult {
  return {
    changes: [change('4521', 'Fix widget'), change('4519', 'Initial')],
    head: '4521',
    headClient: 'alice-ws',
    moreAvailable: false,
    pendingCount: 0,
  }
}

function existingPayload(commitRef: string, providerId = 'perforce'): ShowCommitChangesPayload {
  return {
    providerId,
    title: commitRef,
    commitRef,
    openExternalCommand: 'perforce-graph.openFileDiff',
    files: [],
  }
}

function renderEditor() {
  const executeCommand = vi.fn(async (id: string, arg?: unknown) => {
    switch (id) {
      case PerforceGraphCommands.getChanges:
        return makeResult()
      case PerforceGraphCommands.getRepos:
        return [REPO]
      case PerforceGraphCommands.getChangeDetails:
        return makeDetails(arg as string)
      default:
        return undefined
    }
  })
  const services = new ServiceCollection()
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService)
  services.set(IScmService, {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', []),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService)
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
  } as unknown as IViewsService)
  services.set(IViewDescriptorService, {
    _serviceBrand: undefined,
    setViewCollapsed: vi.fn(),
  } as unknown as IViewDescriptorService)
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService)
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <PerforceGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { executeCommand, ...utils }
}

async function flush(): Promise<void> {
  // Several rounds: the storage-read → restore-decision → default-selection
  // chain schedules one React render per step.
  for (let round = 0; round < 10; round++) {
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  perforceGraphViewState.revealCommit = null
  perforceGraphViewState.pendingReveal.set(null, undefined)
  perforceGraphViewState.result = null
  perforceGraphViewState.selection = []
  perforceGraphViewState.repos = []
  perforceGraphViewState.selectedRepo = null
  perforceGraphViewState.wholeRepo = false
  scmViewState.setSelectedRepo(undefined)
  commitChangesViewState._resetForTests()
  _clearGraphPayloadCacheForTests()
  vi.clearAllMocks()
})

function bridgeCalls(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === ShowCommitChangesAction.ID)
}

function detailFetches(executeCommand: ReturnType<typeof vi.fn>): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === PerforceGraphCommands.getChangeDetails)
}

describe('PerforceGraphEditor reveal → Commit Changes follow', () => {
  it('silently pushes the revealed changelist into an in-use Commit Changes view', async () => {
    commitChangesViewState.show(existingPayload('4521'))
    const { executeCommand } = renderEditor()
    await flush()

    await act(async () => {
      perforceGraphViewState.pendingReveal.set('4519', undefined)
      await flush()
    })

    expect(perforceGraphViewState.selection).toEqual(['4519'])
    const calls = bridgeCalls(executeCommand)
    // calls[0] is the open-time default selection pushing '4521' (click
    // semantics); calls[1] is the silent reveal follow.
    expect(calls).toHaveLength(2)
    const payload = calls[1]![1] as Record<string, unknown>
    expect(payload.commitRef).toBe('4519')
    expect(payload.silent).toBe(true)
  })

  it('fetches nothing for the reveal while the Commit Changes view has never been used', async () => {
    const { executeCommand } = renderEditor()
    await flush()

    await act(async () => {
      perforceGraphViewState.pendingReveal.set('4519', undefined)
      await flush()
    })

    expect(perforceGraphViewState.selection).toEqual(['4519'])
    // The only fetch/bridge is the open-time default selection of '4521'; the
    // reveal itself stays gated because the mocked ShowCommitChanges never
    // ran, so the view still counts as unused.
    expect(detailFetches(executeCommand).map((c) => c[1])).toEqual(['4521'])
    expect(bridgeCalls(executeCommand)).toHaveLength(1)
  })

  it('does not refetch the changelist the view already shows', async () => {
    commitChangesViewState.show(existingPayload('4519'))
    const { executeCommand } = renderEditor()
    await flush()

    await act(async () => {
      perforceGraphViewState.pendingReveal.set('4519', undefined)
      await flush()
    })

    expect(perforceGraphViewState.selection).toEqual(['4519'])
    // Only the open-time default selection fetched — the revealed '4519' was
    // already shown, so its follow was skipped.
    expect(detailFetches(executeCommand).map((c) => c[1])).toEqual(['4521'])
    expect(bridgeCalls(executeCommand)).toHaveLength(1)
  })

  it('follows when the view shows another provider', async () => {
    commitChangesViewState.show(existingPayload('abc123', 'git'))
    const { executeCommand } = renderEditor()
    await flush()

    await act(async () => {
      perforceGraphViewState.pendingReveal.set('4519', undefined)
      await flush()
    })

    const calls = bridgeCalls(executeCommand)
    // calls[0] is the open-time default selection; calls[1] is the follow.
    expect(calls).toHaveLength(2)
    expect((calls[1]![1] as Record<string, unknown>).commitRef).toBe('4519')
  })
})
