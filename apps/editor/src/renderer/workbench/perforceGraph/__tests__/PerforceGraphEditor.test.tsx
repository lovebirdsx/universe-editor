/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the Perforce Graph editor: it loads submitted changes, renders
 *  rows, and clicking a row pushes the change's files into the Commit Changes
 *  sidebar view via the `_workbench.showCommitChanges` bridge. Clicking the
 *  synthetic pending-changes node reveals the SCM main view instead.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  ServiceCollection,
  StorageScope,
  observableValue,
} from '@universe-editor/platform'
import {
  PerforceGraphCommands,
  type P4GraphChangeDetailsDto,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { perforceGraphViewState } from '../../../services/perforceGraph/perforceGraphViewState.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { _clearGraphPayloadCacheForTests } from '../../scm/commitChanges/graphPayloadCache.js'
import { ServicesContext } from '../../useService.js'
import { ShowCommitChangesAction } from '../../../actions/commitChangesActions.js'
import { PerforceGraphEditor } from '../PerforceGraphEditor.js'

const REPO: P4GraphRepoDto = { root: 'C:/ws/main', name: 'alice-ws' }

function makeResult(pendingCount = 0): P4GraphLoadResult {
  return {
    changes: [
      {
        id: '4521',
        parents: ['4519'],
        author: 'alice',
        client: 'alice-ws',
        date: 1,
        message: 'Fix widget',
        body: 'Fix widget',
      },
      {
        id: '4519',
        parents: [],
        author: 'bob',
        client: 'bob-ws',
        date: 1,
        message: 'Initial',
        body: 'Initial',
      },
    ],
    head: '4521',
    headClient: 'alice-ws',
    moreAvailable: false,
    pendingCount,
  }
}

function makeDetails(): P4GraphChangeDetailsDto {
  return {
    id: '4521',
    author: 'alice',
    client: 'alice-ws',
    date: 1,
    body: 'Fix widget',
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

function makeCommandService(): ICommandService {
  return {
    _serviceBrand: undefined,
    executeCommand: vi.fn(async (id: string) => {
      switch (id) {
        case PerforceGraphCommands.getChanges:
          return makeResult()
        case PerforceGraphCommands.getRepos:
          return [REPO]
        case PerforceGraphCommands.getChangeDetails:
          return makeDetails()
        default:
          return undefined
      }
    }),
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService
}

function makeScmService(): IScmService {
  return {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', []),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService
}

function makeStorageService(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function makeViewServices(services: ServiceCollection): {
  openViewContainer: ReturnType<typeof vi.fn>
  setViewCollapsed: ReturnType<typeof vi.fn>
} {
  const openViewContainer = vi.fn()
  const setViewCollapsed = vi.fn()
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer,
  } as unknown as IViewsService)
  services.set(IViewDescriptorService, {
    _serviceBrand: undefined,
    setViewCollapsed,
  } as unknown as IViewDescriptorService)
  return { openViewContainer, setViewCollapsed }
}

function renderEditor() {
  const commandService = makeCommandService()
  const storageService = makeStorageService()
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IScmService, makeScmService())
  services.set(IStorageService, storageService)
  const viewServices = makeViewServices(services)
  const instantiation = new InstantiationService(services)
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <PerforceGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { commandService, storageService, ...viewServices, ...utils }
}

async function flush(): Promise<void> {
  // Several macro rounds: the storage-read → restore-decision →
  // default-selection → payload-fetch chain schedules one React render per step, and each
  // render is flushed on its own macrotask.
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
}

function resetViewState(): void {
  perforceGraphViewState.result = null
  perforceGraphViewState.selection = []
  perforceGraphViewState.repos = []
  perforceGraphViewState.selectedRepo = null
  perforceGraphViewState.wholeRepo = false
}

beforeEach(() => {
  resetViewState()
})

afterEach(() => {
  resetViewState()
  scmViewState.setSelectedRepo(undefined)
  _clearGraphPayloadCacheForTests()
  vi.clearAllMocks()
})

describe('PerforceGraphEditor', () => {
  it('loads and renders submitted changes newest-first', async () => {
    renderEditor()
    await flush()

    expect(screen.getByText('Fix widget')).toBeTruthy()
    expect(screen.getByText('Initial')).toBeTruthy()
    expect(screen.getByText('#4521')).toBeTruthy()
  })

  it('defaults to the opened folder and toggles to whole-repo scope', async () => {
    const { commandService, storageService } = renderEditor()
    await flush()

    // Initial load scopes to the opened folder (wholeRepo omitted/false).
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      PerforceGraphCommands.getChanges,
      expect.objectContaining({ wholeRepo: false }),
    )

    fireEvent.click(screen.getByLabelText('Toggle repository scope'))
    await flush()

    // Flipping the toggle reloads with the whole-repo scope and persists it.
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      PerforceGraphCommands.getChanges,
      expect.objectContaining({ wholeRepo: true }),
    )
    expect(storageService.set).toHaveBeenCalledWith(
      'perforceGraph.wholeRepo',
      true,
      StorageScope.WORKSPACE,
    )
  })

  it('selects the first change on open and shows it in the Commit Changes view', async () => {
    const { commandService } = renderEditor()
    await flush()

    expect(perforceGraphViewState.selection).toEqual(['4521'])
    const calls = (commandService.executeCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === ShowCommitChangesAction.ID,
    )
    expect(calls).toHaveLength(1)
    const payload = calls[0]![1] as Record<string, unknown>
    expect(payload.providerId).toBe('perforce')
    expect(payload.title).toBe('Changelist 4521 — Fix widget')
    expect(payload.commitRef).toBe('4521')
    expect(payload.openExternalCommand).toBe('perforce-graph.openFileDiff')
    expect(payload.metadata).toEqual({ author: 'alice', authorDate: 1, message: 'Fix widget' })
    const files = payload.files as {
      path: string
      resourceUri: string | null
      args: Record<string, unknown>
    }[]
    expect(files).toHaveLength(1)
    expect(files[0]!.args).toEqual({
      depotFile: '//depot/main/a.txt',
      status: 'M',
      rev: '3',
      localPath: 'C:/ws/main/a.txt',
    })
    expect(files[0]!.resourceUri).toContain('a.txt')
  })

  it('shows a pending-changes node when files are open', async () => {
    const withPending = makeResult(2)
    const services = new ServiceCollection()
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) => {
        if (id === PerforceGraphCommands.getChanges) return withPending
        if (id === PerforceGraphCommands.getRepos) return [REPO]
        return undefined
      }),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService)
    services.set(IScmService, makeScmService())
    services.set(IStorageService, makeStorageService())
    makeViewServices(services)
    render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <PerforceGraphEditor input={{} as never} />
      </ServicesContext.Provider>,
    )
    await flush()

    expect(screen.getByText('Pending Changes (2)')).toBeTruthy()
  })

  it('clicking the pending-changes node reveals the SCM main view', async () => {
    const withPending = makeResult(2)
    const services = new ServiceCollection()
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) => {
        if (id === PerforceGraphCommands.getChanges) return withPending
        if (id === PerforceGraphCommands.getRepos) return [REPO]
        return undefined
      }),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService)
    services.set(IScmService, makeScmService())
    services.set(IStorageService, makeStorageService())
    const { openViewContainer, setViewCollapsed } = makeViewServices(services)
    const { container } = render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <PerforceGraphEditor input={{} as never} />
      </ServicesContext.Provider>,
    )
    await flush()

    fireEvent.click(container.querySelector('[data-id="*"]')!)
    await flush()

    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.scm')
    expect(setViewCollapsed).toHaveBeenCalledWith('workbench.view.scm.main', false)
  })

  it('opens no context menu for the pending-changes node', async () => {
    const withPending = makeResult(2)
    const services = new ServiceCollection()
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) => {
        if (id === PerforceGraphCommands.getChanges) return withPending
        if (id === PerforceGraphCommands.getRepos) return [REPO]
        return undefined
      }),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService)
    services.set(IScmService, makeScmService())
    services.set(IStorageService, makeStorageService())
    makeViewServices(services)
    const { container } = render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <PerforceGraphEditor input={{} as never} />
      </ServicesContext.Provider>,
    )
    await flush()

    const row = container.querySelector('[data-id="*"]')
    expect(row).toBeTruthy()
    fireEvent.contextMenu(row!)

    expect(screen.queryByRole('menu')).toBeNull()
  })
})
