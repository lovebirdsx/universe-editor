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
import {
  perforceGraphViewState,
  _resetForTests,
} from '../../../services/perforceGraph/perforceGraphViewState.js'
import { PerforceGraphEditorInput } from '../../../services/editor/PerforceGraphEditorInput.js'
import {
  normalizeGraphScopeSelection,
  type GraphScopePath,
} from '../../../services/perforceGraph/graphScopeSelection.js'
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
  // Drops the scoped buckets too — the scoped/merged suites below reuse an input
  // id across cases, and a leftover `view.result` sends the next render down the
  // silent-revalidate path instead of a fresh load.
  _resetForTests()
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
      resourcePath: string | null
      args: Record<string, unknown>
    }[]
    expect(files).toHaveLength(1)
    expect(files[0]!.args).toEqual({
      depotFile: '//depot/main/a.txt',
      status: 'M',
      rev: '3',
      localPath: 'C:/ws/main/a.txt',
    })
    expect(files[0]!.resourcePath).toContain('a.txt')
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

describe('PerforceGraphEditor scoped history', () => {
  function makeScopedCommandService(
    details?: P4GraphChangeDetailsDto,
    result?: P4GraphLoadResult,
  ): ICommandService {
    return {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) => {
        switch (id) {
          case PerforceGraphCommands.getChanges:
            return result ?? makeResult()
          case PerforceGraphCommands.getRepos:
            return [REPO, { root: 'X:/p4ws/other', name: 'other-ws' }]
          case PerforceGraphCommands.getChangeDetails:
            return details ?? makeDetails()
          default:
            return undefined
        }
      }),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService
  }

  function renderScoped(
    paths: readonly GraphScopePath[],
    details?: P4GraphChangeDetailsDto,
    result?: P4GraphLoadResult,
  ) {
    const commandService = makeScopedCommandService(details, result)
    const storageService = makeStorageService()
    const services = new ServiceCollection()
    services.set(ICommandService, commandService)
    services.set(IScmService, makeScmService())
    services.set(IStorageService, storageService)
    makeViewServices(services)
    const utils = render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <PerforceGraphEditor
          input={new PerforceGraphEditorInput(normalizeGraphScopeSelection(paths))}
        />
      </ServicesContext.Provider>,
    )
    return { commandService, storageService, ...utils }
  }

  it('scopes the query to the path and drops the whole-repo chrome', async () => {
    const { commandService, container } = renderScoped([
      { path: 'X:/p4ws/main', isDirectory: true },
    ])
    await flush()

    expect(commandService.executeCommand).toHaveBeenCalledWith(
      PerforceGraphCommands.getChanges,
      expect.objectContaining({ scopePaths: [{ path: 'X:/p4ws/main', isDirectory: true }] }),
    )
    const getChangesCalls = (
      commandService.executeCommand as ReturnType<typeof vi.fn>
    ).mock.calls.filter((c) => c[0] === PerforceGraphCommands.getChanges)
    for (const call of getChangesCalls) {
      expect(call[1]).not.toHaveProperty('wholeRepo')
    }

    expect(screen.queryByLabelText('Toggle repository scope')).toBeNull()
    expect(container.querySelector('select')).toBeNull()
    expect(screen.getByText('History: main')).toBeTruthy()
    expect(commandService.executeCommand).not.toHaveBeenCalledWith(
      PerforceGraphCommands.setRepo,
      expect.anything(),
    )
  })

  it('single-file scope adds an "Open Changes" menu item for the matching file', async () => {
    const details: P4GraphChangeDetailsDto = {
      ...makeDetails(),
      files: [
        {
          status: 'M',
          path: 'depot/branch_x/a.txt',
          oldPath: null,
          depotFile: '//depot/branch_x/a.txt',
          rev: '3',
          localPath: 'X:/p4ws/main/a.txt',
        },
      ],
    }
    const { commandService, container } = renderScoped(
      [{ path: 'X:/p4ws/main/a.txt', isDirectory: false }],
      details,
    )
    await flush()

    const row = container.querySelector('[data-id="4521"]')
    expect(row).toBeTruthy()
    fireEvent.contextMenu(row!)
    await flush()

    expect(screen.getByText('Open Changes')).toBeTruthy()
    fireEvent.click(screen.getByText('Open Changes'))
    await flush()

    expect(commandService.executeCommand).toHaveBeenCalledWith(
      PerforceGraphCommands.openFileDiff,
      expect.objectContaining({ depotFile: '//depot/branch_x/a.txt', rev: '3', status: 'M' }),
    )
  })

  it('offers "Open Changes" without describing the change first', async () => {
    const { commandService, container } = renderScoped([
      { path: 'X:/p4ws/main/a.txt', isDirectory: false },
    ])
    await flush()
    ;(commandService.executeCommand as ReturnType<typeof vi.fn>).mockClear()

    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)

    // The item is up on the same tick as the right-click: `describe -s` is
    // GB-scale on a giant branch CL and must never gate the menu.
    expect(screen.getByText('Open Changes')).toBeTruthy()
    expect(commandService.executeCommand).not.toHaveBeenCalledWith(
      PerforceGraphCommands.getChangeDetails,
      expect.anything(),
    )
  })

  it('falls back to showing the whole change when the scoped file is not in it', async () => {
    const details: P4GraphChangeDetailsDto = {
      ...makeDetails(),
      files: [
        {
          status: 'M',
          path: 'depot/branch_x/other.txt',
          oldPath: null,
          depotFile: '//depot/branch_x/other.txt',
          rev: '1',
          localPath: 'X:/p4ws/main/other.txt',
        },
      ],
    }
    const { commandService, container } = renderScoped(
      [{ path: 'X:/p4ws/main/a.txt', isDirectory: false }],
      details,
    )
    await flush()

    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)
    fireEvent.click(screen.getByText('Open Changes'))
    await flush()

    expect(commandService.executeCommand).not.toHaveBeenCalledWith(
      PerforceGraphCommands.openFileDiff,
      expect.anything(),
    )
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      ShowCommitChangesAction.ID,
      expect.anything(),
    )
  })
})

describe('PerforceGraphEditor merged (multi-select) history', () => {
  const MERGED: GraphScopePath[] = [
    { path: 'X:/p4ws/main/a.txt', isDirectory: false },
    { path: 'X:/p4ws/main/lib', isDirectory: true },
  ]

  function renderMerged(
    result?: P4GraphLoadResult,
    details?: P4GraphChangeDetailsDto,
    paths: GraphScopePath[] = MERGED,
  ) {
    const commandService = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) => {
        switch (id) {
          case PerforceGraphCommands.getChanges:
            return result ?? makeResult()
          case PerforceGraphCommands.getRepos:
            return [REPO]
          case PerforceGraphCommands.getChangeDetails:
            return details ?? makeDetails()
          default:
            return undefined
        }
      }),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService
    const services = new ServiceCollection()
    services.set(ICommandService, commandService)
    services.set(IScmService, makeScmService())
    services.set(IStorageService, makeStorageService())
    makeViewServices(services)
    const utils = render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <PerforceGraphEditor
          input={new PerforceGraphEditorInput(normalizeGraphScopeSelection(paths))}
        />
      </ServicesContext.Provider>,
    )
    return { commandService, ...utils }
  }

  it('sends every selected path as one scopePaths query and titles the tab with +N', async () => {
    const { commandService } = renderMerged()
    await flush()

    expect(commandService.executeCommand).toHaveBeenCalledWith(
      PerforceGraphCommands.getChanges,
      expect.objectContaining({
        scopePaths: [
          { path: 'X:/p4ws/main/a.txt', isDirectory: false },
          { path: 'X:/p4ws/main/lib', isDirectory: true },
        ],
      }),
    )
    expect(screen.getByText('History: a.txt +1')).toBeTruthy()
  })

  it('offers both Get items and no "Open Changes" (ambiguous across paths)', async () => {
    const { commandService, container } = renderMerged()
    await flush()

    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)
    await flush()

    expect(screen.queryByText('Open Changes')).toBeNull()
    fireEvent.click(screen.getByText('Get This Revision'))
    await flush()
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      PerforceGraphCommands.syncToChange,
      expect.objectContaining({
        change: '4521',
        scopePaths: [
          { path: 'X:/p4ws/main/a.txt', isDirectory: false },
          { path: 'X:/p4ws/main/lib', isDirectory: true },
        ],
      }),
    )
  })

  it('Get Latest Revision reuses the extension multi-select (primary, selection) form', async () => {
    const { commandService, container } = renderMerged()
    await flush()

    fireEvent.contextMenu(container.querySelector('[data-id="4519"]')!)
    await flush()
    fireEvent.click(screen.getByText('Get Latest Revision'))
    await flush()

    const selection = [
      { resourceUri: 'X:/p4ws/main/a.txt', isDirectory: false },
      { resourceUri: 'X:/p4ws/main/lib', isDirectory: true },
    ]
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      'perforce.syncLatest',
      selection[0],
      selection,
    )
  })

  it('shows a dedicated empty state (and no count row) when the paths span clients', async () => {
    const multiClient: P4GraphLoadResult = {
      changes: [],
      head: null,
      headClient: null,
      moreAvailable: false,
      pendingCount: 0,
      error: 'multiClient',
    }
    renderMerged(multiClient)
    await flush()

    expect(
      screen.getByText(
        'The selected paths are not in one Perforce workspace, so their history cannot be merged.',
      ),
    ).toBeTruthy()
    // Not "0 changes" — that reads like a successful empty listing.
    expect(screen.queryByText(/changes/)).toBeNull()
  })

  it('narrows the Commit Changes payload to the selection and counts what it hid', async () => {
    const details: P4GraphChangeDetailsDto = {
      ...makeDetails(),
      files: [
        {
          status: 'M',
          path: 'depot/branch_x/a.txt',
          oldPath: null,
          depotFile: '//depot/branch_x/a.txt',
          rev: '3',
          localPath: 'X:/p4ws/main/a.txt',
        },
        {
          status: 'A',
          path: 'depot/branch_x/lib/x.ts',
          oldPath: null,
          depotFile: '//depot/branch_x/lib/x.ts',
          rev: '1',
          localPath: 'X:/p4ws/main/lib/x.ts',
        },
        {
          status: 'M',
          path: 'depot/branch_x/unrelated.txt',
          oldPath: null,
          depotFile: '//depot/branch_x/unrelated.txt',
          rev: '7',
          localPath: 'X:/p4ws/main/unrelated.txt',
        },
      ],
    }
    const { commandService, container } = renderMerged(undefined, details)
    await flush()

    fireEvent.click(container.querySelector('[data-id="4521"]')!)
    await flush()

    const call = (commandService.executeCommand as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === ShowCommitChangesAction.ID,
    )
    expect(call).toBeTruthy()
    const payload = call![1] as { files: { path: string }[]; subtitle?: string }
    expect(payload.files.map((f) => f.path)).toEqual([
      'depot/branch_x/a.txt',
      'depot/branch_x/lib/x.ts',
    ])
    expect(payload.subtitle).toContain('1 more file(s)')
  })

  it('does not share one cached payload between two differently-scoped tabs', async () => {
    // The payload cache is module-level and keyed by the caller. Without the scope
    // signature in that key, whichever tab fetched the changelist first would pin
    // its filtered file list for the other — the second tab would show the wrong
    // files and the wrong "N more file(s)" count. The cache is NOT cleared between
    // the two renders here on purpose: that is exactly the cross-tab condition.
    const details: P4GraphChangeDetailsDto = {
      ...makeDetails(),
      files: [
        {
          status: 'M',
          path: 'depot/branch_x/a.txt',
          oldPath: null,
          depotFile: '//depot/branch_x/a.txt',
          rev: '3',
          localPath: 'X:/p4ws/main/a.txt',
        },
        {
          status: 'A',
          path: 'depot/branch_x/lib/x.ts',
          oldPath: null,
          depotFile: '//depot/branch_x/lib/x.ts',
          rev: '1',
          localPath: 'X:/p4ws/main/lib/x.ts',
        },
      ],
    }
    const payloadOf = async (paths: GraphScopePath[]): Promise<{ files: { path: string }[] }> => {
      const { commandService, container, unmount } = renderMerged(undefined, details, paths)
      await flush()
      fireEvent.click(container.querySelector('[data-id="4521"]')!)
      await flush()
      const call = (commandService.executeCommand as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === ShowCommitChangesAction.ID,
      )
      unmount()
      return call![1] as { files: { path: string }[] }
    }

    // Both selections are multi-path (only those filter) and both hit CL 4521.
    const first = await payloadOf([
      { path: 'X:/p4ws/main/a.txt', isDirectory: false },
      { path: 'X:/p4ws/main/other', isDirectory: true },
    ])
    const second = await payloadOf([
      { path: 'X:/p4ws/main/lib', isDirectory: true },
      { path: 'X:/p4ws/main/other', isDirectory: true },
    ])

    expect(first.files.map((f) => f.path)).toEqual(['depot/branch_x/a.txt'])
    expect(second.files.map((f) => f.path)).toEqual(['depot/branch_x/lib/x.ts'])
  })
})
