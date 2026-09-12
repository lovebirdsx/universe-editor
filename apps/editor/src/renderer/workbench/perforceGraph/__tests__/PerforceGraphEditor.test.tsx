/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the Perforce Graph editor: it loads submitted changes, renders
 *  rows, and clicking a row pushes the change's files into the Commit Changes
 *  sidebar view via the `_workbench.showCommitChanges` bridge. Clicking the
 *  synthetic pending-changes node reveals the SCM main view instead.
 *--------------------------------------------------------------------------------------------*/

import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import {
  Event,
  ICommandService,
  INotificationService,
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
  type P4GraphHaveChangeOptions,
  type P4GraphHaveChangeResult,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
  type P4GraphSyncPoint,
  type P4GraphSyncScopeDto,
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

/** Candidates `getSyncScopes` answers with (drives the "Get Revision…" dialog). */
const SYNC_SCOPES: readonly P4GraphSyncScopeDto[] = [
  { name: 'assets', path: 'X:/p4ws/main/assets' },
  { name: 'src', path: 'X:/p4ws/main/src' },
]

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

/** A paged history: the given rows newest-first, exactly as `p4 changes` returns
 *  them, with older history still behind it (`moreAvailable`). */
function pagedResult(ids: readonly string[], moreAvailable = true): P4GraphLoadResult {
  return {
    changes: ids.map((id) => ({
      id,
      parents: [],
      author: 'alice',
      client: 'alice-ws',
      date: 1,
      message: `Change ${id}`,
      body: `Change ${id}`,
    })),
    head: ids[0] ?? null,
    headClient: 'alice-ws',
    moreAvailable,
    pendingCount: 0,
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

/** The ledger's answer for the scope under test (`perforce-graph.getSyncPoint`) —
 *  what a get this editor ran left behind. `source`/`widerScope`/`partial` are
 *  the provenance the toolbar tooltip is built from. */
function ledgerPoint(id: string, extra: Partial<P4GraphSyncPoint> = {}): P4GraphSyncPoint {
  return {
    id,
    source: 'sync',
    at: 1_700_000_000_000,
    widerScope: false,
    partial: false,
    ...extra,
  }
}

/**
 * `ledger` is what `getSyncPoint` answers (zero p4 calls), `query` what a server
 * query answers (`getHaveChange`). They are separate commands precisely because
 * they cost different things: the graph reads the ledger on every load and only
 * reaches the server when the ledger is empty and the scope makes it affordable.
 */
function makeCommandService(
  ledger: P4GraphSyncPoint | null = null,
  query: string | null = null,
): ICommandService {
  return {
    _serviceBrand: undefined,
    executeCommand: vi.fn(async (id: string) => {
      switch (id) {
        case PerforceGraphCommands.getChanges:
          return makeResult()
        case PerforceGraphCommands.getSyncPoint:
          return ledger
        case PerforceGraphCommands.getHaveChange:
          return { id: query, failed: false } satisfies P4GraphHaveChangeResult
        case PerforceGraphCommands.getRepos:
          return [REPO]
        case PerforceGraphCommands.getChangeDetails:
          return makeDetails()
        case PerforceGraphCommands.getSyncScopes:
          return SYNC_SCOPES
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

function renderEditor(
  ledger: P4GraphSyncPoint | null = null,
  input?: PerforceGraphEditorInput,
  query: string | null = null,
) {
  const commandService = makeCommandService(ledger, query)
  const storageService = makeStorageService()
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IScmService, makeScmService())
  services.set(IStorageService, storageService)
  const viewServices = makeViewServices(services)
  const instantiation = new InstantiationService(services)
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <PerforceGraphEditor input={input ?? ({} as never)} />
    </ServicesContext.Provider>,
  )
  return { commandService, storageService, ...viewServices, ...utils }
}

/** Unscoped render plus a graph scope on the input — the scoped tab's shape. */
function renderScopedEditor(
  paths: readonly GraphScopePath[],
  ledger: P4GraphSyncPoint | null = null,
  query: string | null = null,
) {
  return renderEditor(
    ledger,
    new PerforceGraphEditorInput(normalizeGraphScopeSelection(paths)),
    query,
  )
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

/** One scoped-history target, shared by the scoped suites below. */
const SCOPED_PATHS: readonly GraphScopePath[] = [{ path: 'X:/p4ws/main', isDirectory: true }]

/** What the toolbar line shows before anything is known (or asked). */
const UNKNOWN_SYNC_POINT = '#? (click to query)'

/** The changelist button's own text — `#4521`, or {@link UNKNOWN_SYNC_POINT}. */
function syncPointText(): string {
  return screen.getByTestId('perforceGraph-syncPoint').textContent ?? ''
}

/** The whole " · Synced to …" sentence, read off the count span it sits in. The
 *  changelist is a button of its own (it is clickable), so a text query for the
 *  full sentence finds nothing — the text is split across elements on purpose. */
function syncLine(): string {
  return screen.getByTestId('perforceGraph-syncPoint').parentElement?.textContent ?? ''
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

  it('offers a force get that carries the whole-repo toggle, with no waivers', async () => {
    const { commandService, container } = renderEditor()
    await flush()

    // 4521 is this graph's head — the row whose plain get carries `isLatest`.
    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)
    await flush()

    fireEvent.click(screen.getByText('Force Get (Overwrite Local Files)'))
    await flush()

    // Exact equality on purpose: an extra `isLatest`/`confirmed` fails here.
    expect(commandService.executeCommand).toHaveBeenCalledWith(PerforceGraphCommands.syncToChange, {
      change: '4521',
      wholeRepo: false,
      force: true,
    })
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

  it('force get sends no time-travel waivers — even on the newest row', async () => {
    const { commandService, container } = renderMerged()
    await flush()

    // 4521 is this graph's head, i.e. the row that would carry `isLatest: true`
    // on a plain get. Force must not: the extension's force prompt has no waiver.
    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)
    await flush()
    fireEvent.click(screen.getByText('Force Get (Overwrite Local Files)'))
    await flush()

    // Exact equality on purpose: an extra `isLatest`/`confirmed` fails here.
    expect(commandService.executeCommand).toHaveBeenCalledWith(PerforceGraphCommands.syncToChange, {
      change: '4521',
      scopePaths: [
        { path: 'X:/p4ws/main/a.txt', isDirectory: false },
        { path: 'X:/p4ws/main/lib', isDirectory: true },
      ],
      force: true,
    })
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

describe('PerforceGraphEditor sync point', () => {
  const BADGE_TOOLTIP =
    'The newest changelist this workspace has been synced to; changes newer than this row are not synced yet (the toolbar’s “Synced to” has the provenance and its age).'

  it('badges only the row holding the ledger’s sync point', async () => {
    const { container } = renderEditor(ledgerPoint('4519'))
    await flush()

    const synced = container.querySelector('[data-id="4519"]') as HTMLElement
    const newer = container.querySelector('[data-id="4521"]') as HTMLElement
    expect(within(synced).getByText('Synced')).toBeTruthy()
    expect(within(newer).queryByText('Synced')).toBeNull()
  })

  it('explains the badge in its tooltip', async () => {
    const { container } = renderEditor(ledgerPoint('4519'))
    await flush()

    const badge = within(container.querySelector('[data-id="4519"]') as HTMLElement).getByText(
      'Synced',
    )
    expect(badge.getAttribute('data-tooltip')).toBe(BADGE_TOOLTIP)
  })

  it('summarises the sync point in the toolbar', async () => {
    renderEditor(ledgerPoint('4519'))
    await flush()

    expect(syncLine()).toContain('Synced to #4519')
  })

  it('shows no badge when the ledger has nothing for the scope', async () => {
    renderEditor(null)
    await flush()

    expect(screen.queryByText('Synced')).toBeNull()
  })

  it('keeps the toolbar line, and drops the badge, for a paged-out sync point', async () => {
    // 4400 is older than the loaded page: the marker is never paged in for (the
    // badge only labels a rendered row), so the toolbar line is the one signal
    // that survives.
    const { container } = renderEditor(ledgerPoint('4400'))
    await flush()

    expect(container.querySelectorAll('[data-id]').length).toBe(2)
    expect(screen.queryByText('Synced')).toBeNull()
    expect(syncLine()).toContain('Synced to #4400')
  })

  it('does not ask the server for a whole-graph scope', async () => {
    // The whole-repo / opened-folder graph is the expensive case (~40s on a big
    // workspace), so an empty ledger says "not known, click to query" instead of
    // paying it on every load.
    const { commandService } = renderEditor(null)
    await flush()

    const calls = (commandService.executeCommand as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((c) => c[0] === PerforceGraphCommands.getHaveChange)).toBe(false)
    expect(syncPointText()).toBe(UNKNOWN_SYNC_POINT)
  })

  it('asks the server on its own for a scoped history, whose probe is cheap', async () => {
    const { container } = renderScopedEditor(SCOPED_PATHS, null, '4519')
    await flush()

    expect(
      within(container.querySelector('[data-id="4519"]') as HTMLElement).getByText('Synced'),
    ).toBeTruthy()
  })

  it('prefers the ledger over the server, even for a scoped history', async () => {
    const { commandService } = renderScopedEditor(SCOPED_PATHS, ledgerPoint('4519'), '4520')
    await flush()

    const calls = (commandService.executeCommand as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((c) => c[0] === PerforceGraphCommands.getHaveChange)).toBe(false)
    expect(syncLine()).toContain('Synced to #4519')
  })

  it('queries on the toolbar button and shows what the server answered', async () => {
    const { commandService } = renderEditor(null, undefined, '4521')
    await flush()
    expect(syncPointText()).toBe(UNKNOWN_SYNC_POINT)

    fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
    await flush()

    expect(commandService.executeCommand).toHaveBeenCalledWith(
      PerforceGraphCommands.getHaveChange,
      expect.objectContaining({ force: true }),
    )
    expect(syncLine()).toContain('Synced to #4521')
  })

  it('queries when the toolbar line itself is clicked', async () => {
    const { commandService } = renderEditor(null, undefined, '4519')
    await flush()

    fireEvent.click(screen.getByTestId('perforceGraph-syncPoint'))
    await flush()

    expect(commandService.executeCommand).toHaveBeenCalledWith(
      PerforceGraphCommands.getHaveChange,
      expect.objectContaining({ force: true }),
    )
    expect(syncLine()).toContain('Synced to #4519')
  })

  it('reveals the named row when the toolbar line is clicked', async () => {
    const { commandService } = renderEditor(ledgerPoint('4519'))
    await flush()
    const before = (commandService.executeCommand as ReturnType<typeof vi.fn>).mock.calls.length

    // Clicking the changelist is a REVEAL, not a query — the whole point of the
    // click being on the id rather than on a "query" affordance. Only the
    // unknown marker asks the server.
    fireEvent.click(screen.getByTestId('perforceGraph-syncPoint'))
    await flush()

    const calls = (commandService.executeCommand as ReturnType<typeof vi.fn>).mock.calls.slice(
      before,
    )
    expect(calls.some((c) => c[0] === PerforceGraphCommands.getHaveChange)).toBe(false)
    expect(perforceGraphViewState.selection).toEqual(['4519'])
  })

  it('says where a recorded sync point came from, and what it cannot know', async () => {
    renderEditor(ledgerPoint('4519'))
    await flush()

    const tooltip = screen.getByTestId('perforceGraph-syncPoint').getAttribute('data-tooltip') ?? ''
    // A record only knows the gets this editor ran — the honest caveat the old
    // "syncs outside the editor count too" wording got wrong.
    expect(tooltip).toContain('outside the editor')
    expect(tooltip).not.toContain('Answered by Perforce')
  })

  it('labels a queried answer as the server’s', async () => {
    renderEditor({ ...ledgerPoint('4519'), source: 'query' })
    await flush()

    const tooltip = screen.getByTestId('perforceGraph-syncPoint').getAttribute('data-tooltip') ?? ''
    expect(tooltip).toContain('Answered by Perforce')
  })

  it('labels an upper bound when the record came from a wider scope', async () => {
    renderEditor(ledgerPoint('4519', { widerScope: true }))
    await flush()

    const tooltip = screen.getByTestId('perforceGraph-syncPoint').getAttribute('data-tooltip') ?? ''
    expect(tooltip).toContain('upper bound')
    expect(tooltip).toContain('wider scope')
  })

  it('labels an upper bound when the recorded pull left files behind', async () => {
    renderEditor(ledgerPoint('4519', { partial: true }))
    await flush()

    const tooltip = screen.getByTestId('perforceGraph-syncPoint').getAttribute('data-tooltip') ?? ''
    expect(tooltip).toContain('upper bound')
    expect(tooltip).toContain('left some files behind')
  })
})

describe('PerforceGraphEditor sync point races', () => {
  /**
   * Both halves of the answer arrive asynchronously — the ledger is a message
   * round trip, a query is a p4 round trip — so either can land after the graph
   * has moved on. Renders with a hand-rolled command service whose answers are
   * settled by the test, in whatever order it likes.
   */
  function renderWithDeferredSyncPoints(
    input?: PerforceGraphEditorInput,
    options: { deferChanges?: boolean; strict?: boolean } = {},
  ): {
    container: HTMLElement
    /** Settles the n-th `getChanges` (a listing load). Only deferred when the
     *  test asked for it — the ordinary cases want the load to settle on flush. */
    changes: ((result?: P4GraphLoadResult) => void)[]
    /** Settles the n-th `getSyncPoint` (ledger read). */
    ledger: ((point: P4GraphSyncPoint | null) => void)[]
    /** Settles the n-th `getHaveChange` (server query). `failed` models a query
     *  that could not answer at all (p4 failed or timed out) — which is not the
     *  same as answering "nothing is synced". */
    queries: ((id: string | null, failed?: boolean) => void)[]
    /** The argument each query was dispatched with (force vs. shared cache). */
    queryArgs: P4GraphHaveChangeOptions[]
    /** Toasts the editor raised (e.g. the duplicate-query notice). */
    notify: ReturnType<typeof vi.fn>
  } {
    const changes: ((result?: P4GraphLoadResult) => void)[] = []
    const ledger: ((point: P4GraphSyncPoint | null) => void)[] = []
    const queries: ((id: string | null, failed?: boolean) => void)[] = []
    const queryArgs: P4GraphHaveChangeOptions[] = []
    const notify = vi.fn()
    const executeCommand = vi.fn((id: string, arg?: P4GraphHaveChangeOptions) => {
      switch (id) {
        case PerforceGraphCommands.getChanges:
          return options.deferChanges
            ? new Promise<P4GraphLoadResult>((resolve) =>
                changes.push((result) => resolve(result ?? makeResult())),
              )
            : Promise.resolve(makeResult())
        case PerforceGraphCommands.getSyncPoint:
          return new Promise<P4GraphSyncPoint | null>((resolve) => ledger.push(resolve))
        case PerforceGraphCommands.getHaveChange:
          queryArgs.push(arg ?? {})
          return new Promise<P4GraphHaveChangeResult>((resolve) =>
            queries.push((haveId, failed = false) => resolve({ id: haveId, failed })),
          )
        case PerforceGraphCommands.getRepos:
          return Promise.resolve([REPO])
        case PerforceGraphCommands.getSyncScopes:
          return Promise.resolve(SYNC_SCOPES)
        default:
          return Promise.resolve(undefined)
      }
    })
    const services = new ServiceCollection()
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand,
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService)
    services.set(IScmService, makeScmService())
    services.set(IStorageService, makeStorageService())
    services.set(INotificationService, {
      _serviceBrand: undefined,
      notify,
    } as unknown as INotificationService)
    makeViewServices(services)
    const instantiation = new InstantiationService(services)
    const tree = (
      <ServicesContext.Provider value={instantiation}>
        <PerforceGraphEditor input={input ?? ({} as never)} />
      </ServicesContext.Provider>
    )
    // `strict` mirrors `pnpm dev`: main.tsx renders the workbench inside StrictMode,
    // which mounts, runs every cleanup once, then mounts again on the SAME instance.
    const utils = render(options.strict ? <StrictMode>{tree}</StrictMode> : tree)
    return { container: utils.container, changes, ledger, queries, queryArgs, notify }
  }

  /** One probe round trip, several flush() rounds and a full re-render: these
   *  run ~0.5s on an idle machine, and the whole-repo check runs every project at
   *  once — the default 5s budget is not enough there. */
  const SLOW = 10_000

  /** The row the badge currently sits on, or null when nothing is badged. */
  function badged(container: HTMLElement): string | null {
    return (
      [...container.querySelectorAll('[data-id]')]
        .find((el) => el.textContent?.includes('Synced'))
        ?.getAttribute('data-id') ?? null
    )
  }

  /** That row's badge tooltip — the badge explains which of the two things it is
   *  marking (the point itself, or the newest change the sync covers). */
  function badgeTooltip(container: HTMLElement): string {
    const row = [...container.querySelectorAll('[data-id]')].find((el) =>
      el.textContent?.includes('Synced'),
    )
    return row?.querySelector('[data-tooltip]')?.getAttribute('data-tooltip') ?? ''
  }

  it('drops a ledger answer whose scope changed under it', async () => {
    const { container, ledger } = renderWithDeferredSyncPoints()
    await flush()
    expect(ledger.length).toBe(1)

    // Switch to whole-repo while the folder-scoped read is still out: its answer
    // describes a different scope and must not badge the new list.
    fireEvent.click(screen.getByLabelText('Toggle repository scope'))
    await flush()
    expect(ledger.length).toBe(2)

    ledger[0]!(ledgerPoint('4519'))
    await flush()
    expect(badged(container)).toBeNull()

    ledger[1]!(ledgerPoint('4521'))
    await flush()
    expect(badged(container)).toBe('4521')
  })

  it(
    'refuses a second press while a query is out, and says why',
    async () => {
      const { container, ledger, queries, queryArgs, notify } = renderWithDeferredSyncPoints()
      await flush()
      ledger[0]!(ledgerPoint('4519'))
      await flush()

      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      expect(queries.length).toBe(1)

      // A second press cannot answer anything the first will not, and it would
      // spend a second whole-scope p4 round trip (tens of seconds) proving it.
      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      expect(queries.length).toBe(1)
      expect(queryArgs.length).toBe(1)
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('already running') }),
      )
      // The press that was refused must not have disturbed the one in flight.
      expect(screen.getByTestId('perforceGraph-querySyncPoint').hasAttribute('data-querying')).toBe(
        true,
      )

      queries[0]!('4521')
      await flush()
      expect(badged(container)).toBe('4521')

      // Once it has answered, the button is live again.
      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      expect(queries.length).toBe(2)
    },
    SLOW,
  )

  it(
    'does not stop the newer clock when an abandoned answer lands',
    async () => {
      const { container, changes, ledger, queries } = renderWithDeferredSyncPoints(undefined, {
        deferChanges: true,
      })
      await flush()
      changes[0]!()
      await flush()
      ledger[0]!(null)
      await flush()

      // Press, then change scope while it is out: the load abandons it (its answer
      // belongs to the scope the user has left) and frees the one-at-a-time slot.
      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      expect(queries.length).toBe(1)
      fireEvent.click(screen.getByLabelText('Toggle repository scope'))
      await flush()
      changes[1]!()
      await flush()
      ledger[1]!(null)
      await flush()
      expect(screen.queryByTestId('perforceGraph-queryElapsed')).toBeNull()

      // The new scope's own query is the one the user is now waiting on.
      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      expect(queries.length).toBe(2)

      // The abandoned answer lands last and must not stop the clock of a press
      // that is still in flight — the user would see "I pressed, it stopped, then
      // it started again".
      queries[0]!('4519')
      await flush()
      expect(screen.getByTestId('perforceGraph-querySyncPoint').hasAttribute('data-querying')).toBe(
        true,
      )
      expect(badged(container)).toBeNull()

      queries[1]!('4521')
      await flush()
      expect(badged(container)).toBe('4521')
    },
    SLOW,
  )

  it(
    'ends the clock the query started, under StrictMode’s dry-run mount',
    async () => {
      // `pnpm dev` renders the workbench inside StrictMode, which mounts, runs every
      // cleanup once, then mounts again — on the SAME instance, so any ref a cleanup
      // flipped stays flipped. The clock the user's query started must still end,
      // otherwise the spinner and the frozen number outlive the answer.
      const { container, ledger, queries } = renderWithDeferredSyncPoints(undefined, {
        strict: true,
      })
      for (let round = 0; round < 3; round++) {
        ledger.forEach((settle) => settle(null))
        await flush()
      }

      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      for (let round = 0; round < 3; round++) {
        ledger.forEach((settle) => settle(null))
        queries.forEach((settle) => settle('4521'))
        await flush()
      }

      expect(screen.getByTestId('perforceGraph-querySyncPoint').hasAttribute('data-querying')).toBe(
        false,
      )
      expect(screen.getByTestId('perforceGraph-queryElapsed').hasAttribute('data-done')).toBe(true)
      expect(badged(container)).toBe('4521')
    },
    SLOW,
  )

  it(
    'does not spin or time the automatic probe of a scoped history',
    async () => {
      // The probe a scoped history runs on its own is cheap (a file or folder), so
      // it gets no clock: the spinner and the held number must mean "the query YOU
      // pressed is running", not "some p4 read is running".
      const { ledger, queries } = renderWithDeferredSyncPoints(
        new PerforceGraphEditorInput(normalizeGraphScopeSelection(SCOPED_PATHS)),
      )
      await flush()
      ledger[0]!(null)
      await flush()
      expect(queries.length).toBe(1)
      expect(screen.queryByTestId('perforceGraph-queryElapsed')).toBeNull()
      expect(screen.getByTestId('perforceGraph-querySyncPoint').hasAttribute('data-querying')).toBe(
        false,
      )

      queries[0]!('4519')
      await flush()
      expect(screen.queryByTestId('perforceGraph-queryElapsed')).toBeNull()
    },
    SLOW,
  )

  it(
    'marks a query that came back without an answer',
    async () => {
      const { container, ledger, queries } = renderWithDeferredSyncPoints()
      await flush()
      ledger[0]!(ledgerPoint('4521'))
      await flush()
      expect(badged(container)).toBe('4521')

      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      queries[0]!(null, true)
      await flush()

      // The number is held — the click really ran for that long — but it is marked
      // as unanswered, which is not the same ending as "answered, nothing moved".
      const elapsed = screen.getByTestId('perforceGraph-queryElapsed')
      expect(elapsed.hasAttribute('data-done')).toBe(true)
      expect(elapsed.hasAttribute('data-failed')).toBe(true)
      expect(badged(container)).toBe('4521')
      expect(syncLine()).toContain('Synced to #4521')
    },
    SLOW,
  )

  it(
    'stops claiming ignorance once a query has answered "nothing is synced"',
    async () => {
      const { ledger, queries } = renderWithDeferredSyncPoints()
      await flush()
      ledger[0]!(null)
      await flush()
      expect(screen.getByTestId('perforceGraph-syncPoint').getAttribute('data-tooltip')).toContain(
        'not known',
      )

      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      queries[0]!(null)
      await flush()

      // `id: null` from the server IS an answer, and one that costs tens of
      // seconds: saying "not known, click to ask" sends the user straight back to
      // the query they just ran.
      expect(screen.getByTestId('perforceGraph-syncPoint').getAttribute('data-tooltip')).toContain(
        'nothing in this scope is synced',
      )
    },
    SLOW,
  )

  it(
    'keeps a ledger read from overwriting the answer it raced',
    async () => {
      // The ledger read takes the SAME sequence as the query if it starts after it
      // (only a user query advances the counter), so the sequence guard cannot
      // catch this one: the read carries pre-query content (the extension writes
      // the ledger only once the query command returns) and must not land on top.
      const { container, ledger, queries } = renderWithDeferredSyncPoints()
      await flush()
      ledger[0]!(null)
      await flush()

      fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
      await flush()
      // A get through the graph re-reads the ledger while the query is still out.
      fireEvent.contextMenu(container.querySelector('[data-id="4519"]')!)
      fireEvent.click(screen.getByText('Get This Revision'))
      await flush()
      expect(ledger.length).toBe(2)

      queries[0]!('4521')
      await flush()
      expect(badged(container)).toBe('4521')

      // The raced read resolves last, with what the ledger held before the query.
      ledger[1]!(ledgerPoint('4519'))
      await flush()
      expect(badged(container)).toBe('4521')
      expect(syncLine()).toContain('Synced to #4521')
    },
    SLOW,
  )

  it('keeps the last point when a query fails to answer', async () => {
    const { container, ledger, queries } = renderWithDeferredSyncPoints()
    await flush()
    ledger[0]!(ledgerPoint('4521'))
    await flush()
    expect(badged(container)).toBe('4521')

    // Ask the server and have it fail. `failed` is not an answer: the recorded
    // point is still the best information available.
    fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
    await flush()
    expect(queries.length).toBe(1)
    queries[0]!(null, true)
    await flush()
    expect(badged(container)).toBe('4521')
    expect(syncLine()).toContain('Synced to #4521')
  })

  it('drops the point when the query answers "nothing synced"', async () => {
    // An empty have list IS an answer — a get to an older changelist moves the
    // sync point back, and a workspace can be reverted — so it must clear the
    // marker rather than be mistaken for a failure.
    const { container, ledger, queries } = renderWithDeferredSyncPoints()
    await flush()
    ledger[0]!(ledgerPoint('4521'))
    await flush()
    expect(badged(container)).toBe('4521')

    fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
    await flush()
    queries[0]!(null)
    await flush()
    expect(badged(container)).toBeNull()
    expect(syncPointText()).toBe(UNKNOWN_SYNC_POINT)
    expect(container.querySelectorAll('[data-id]').length).toBe(2)
  })

  it('keeps a user query that a load lands on top of', async () => {
    // The bad race, and the one a scope toggle sets up: press the query button
    // while the new scope's load is still out, and the load's own ledger read
    // arrives first. That read only fills a blank — it must not discard an answer
    // the user is waiting on (a p4 round trip that costs tens of seconds on a real
    // workspace, and one they pressed a button for).
    const { container, changes, ledger, queries } = renderWithDeferredSyncPoints(undefined, {
      deferChanges: true,
    })
    await flush()
    expect(changes.length).toBe(1)
    changes[0]!()
    await flush()
    ledger[0]!(ledgerPoint('4519'))
    await flush()
    expect(badged(container)).toBe('4519')

    // Widen the scope: its load is handed back to the test, so it is still in
    // flight when the query goes out.
    fireEvent.click(screen.getByLabelText('Toggle repository scope'))
    await flush()
    expect(changes.length).toBe(2)
    fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
    await flush()
    expect(queries.length).toBe(1)

    // The load lands first and reads the ledger for the widened scope — which has
    // nothing recorded for it.
    changes[1]!()
    await flush()
    expect(ledger.length).toBe(2)
    ledger[1]!(null)
    await flush()

    // The query still answers, and its answer is the one on screen.
    queries[0]!('4521')
    await flush()
    expect(badged(container)).toBe('4521')
    expect(syncLine()).toContain('Synced to #4521')
  })

  it(
    'spins the icon and runs the clock until the answer lands, then holds the number',
    async () => {
      // The deferred harness is what makes the in-flight window observable at all:
      // a probe can take tens of seconds on a wide scope, and without a mark on the
      // button a click is indistinguishable from a miss. The held number serves the
      // other end — on a fast scope the answer beats the first tick, and "0.2s"
      // appearing is the only proof the click was acted on.
      const { ledger, queries } = renderWithDeferredSyncPoints()
      await flush()
      ledger[0]!(ledgerPoint('4519'))
      await flush()

      const button = screen.getByTestId('perforceGraph-querySyncPoint')
      expect(button.hasAttribute('data-querying')).toBe(false)
      expect(screen.queryByTestId('perforceGraph-queryElapsed')).toBeNull()

      fireEvent.click(button)
      await flush()
      expect(queries.length).toBe(1)
      expect(button.hasAttribute('data-querying')).toBe(true)
      const running = screen.getByTestId('perforceGraph-queryElapsed')
      expect(running.textContent).toMatch(/^\d+\.\ds$/)
      expect(running.hasAttribute('data-done')).toBe(false)

      // The number has to MOVE: the initial state is already "0.0s", so a frozen
      // clock would satisfy every other assertion here. Poll rather than sleep a
      // fixed interval — a loaded machine can delay the tick past any budget.
      await vi.waitFor(
        () => expect(screen.getByTestId('perforceGraph-queryElapsed').textContent).not.toBe('0.0s'),
        { timeout: 3000 },
      )

      queries[0]!('4521')
      await flush()
      expect(button.hasAttribute('data-querying')).toBe(false)
      const held = screen.getByTestId('perforceGraph-queryElapsed')
      expect(held.hasAttribute('data-done')).toBe(true)
      expect(held.textContent).toMatch(/^\d+\.\ds$/)
      expect(syncLine()).toContain('Synced to #4521')
    },
    SLOW,
  )

  it('offers the query and the jump from the row menu', async () => {
    const { container, ledger, queries, queryArgs } = renderWithDeferredSyncPoints()
    await flush()
    ledger[0]!(ledgerPoint('4519'))
    await flush()
    // The graph opens on the newest row, so a jump is visible as a move away.
    expect(perforceGraphViewState.selection).toEqual(['4521'])

    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)
    fireEvent.click(screen.getByText('Query Sync Point'))
    await flush()
    expect(queryArgs[0]).toMatchObject({ force: true })
    queries[0]!('4519')
    await flush()
    expect(badged(container)).toBe('4519')

    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)
    fireEvent.click(screen.getByText('Go to Sync Point'))
    await flush()
    expect(perforceGraphViewState.selection).toEqual(['4519'])
  })

  it('offers no jump while the sync point is unknown', async () => {
    const { container } = renderEditor(null)
    await flush()

    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)

    expect(screen.getByText('Query Sync Point')).toBeTruthy()
    expect(screen.queryByText('Go to Sync Point')).toBeNull()
  })

  it(
    'lands on the newest change the sync covers when the point has no row here',
    async () => {
      // A wider record answers for scopes its get never touched, so this history
      // has no row for #4500 — and never will: rows are ordered by changelist
      // number, and the first page already reaches below it. Paging for it used to
      // pull the whole history in (20 pages) and land nowhere.
      const { container, changes, ledger, notify } = renderWithDeferredSyncPoints(undefined, {
        deferChanges: true,
      })
      for (let round = 0; round < 3; round++) {
        changes.forEach((settle) => settle(pagedResult(['4521', '4519', '4400'])))
        ledger.forEach((settle) => settle(ledgerPoint('4500', { widerScope: true })))
        await flush()
      }
      const dispatched = changes.length
      expect(badged(container)).toBe('4400')

      fireEvent.click(screen.getByTestId('perforceGraph-syncPoint'))
      await flush()

      // No page was fetched — the point cannot be in this history.
      expect(changes.length).toBe(dispatched)
      // The toolbar keeps the record's own changelist (it is the honest upper bound
      // and carries the provenance); the row it lands on is where this scope
      // actually stands, and says so.
      expect(syncPointText()).toBe('#4500')
      expect(perforceGraphViewState.selection).toEqual(['4400'])
      expect(badged(container)).toBe('4400')
      expect(badgeTooltip(container)).toContain('changed nothing under this scope')
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('4500') }),
      )
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('4400') }),
      )
    },
    SLOW,
  )

  it(
    'says nothing here is synced when the point is older than every change in the scope',
    async () => {
      const { container, changes, ledger, notify } = renderWithDeferredSyncPoints(undefined, {
        deferChanges: true,
      })
      for (let round = 0; round < 3; round++) {
        changes.forEach((settle) => settle(pagedResult(['4700', '4650'], false)))
        ledger.forEach((settle) => settle(ledgerPoint('4600', { widerScope: true })))
        await flush()
      }

      fireEvent.click(screen.getByTestId('perforceGraph-syncPoint'))
      await flush()

      // Every row here is NEWER than the point, so the sync covers none of them and
      // there is no row to badge — saying "not known" would hide that answer.
      expect(badged(container)).toBeNull()
      expect(perforceGraphViewState.selection).toEqual(['4700'])
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('every change here is newer') }),
      )
    },
    SLOW,
  )

  it('queries with force only when the user asks, never on a revalidate', async () => {
    // A scoped history probes on its own — its cost is a file or folder, not a
    // workspace — but only through the shared answer; re-running the probe is
    // the user pressing the button.
    const { container, ledger, queries, queryArgs } = renderWithDeferredSyncPoints(
      new PerforceGraphEditorInput(normalizeGraphScopeSelection(SCOPED_PATHS)),
    )
    await flush()
    ledger[0]!(null)
    await flush()
    expect(queryArgs[0]).toMatchObject({ force: false })
    queries[0]!('4521')
    await flush()
    expect(badged(container)).toBe('4521')

    // A get through the graph re-reads the ledger (which the extension updated
    // before the sync resolved) — not the server.
    fireEvent.contextMenu(container.querySelector('[data-id="4519"]')!)
    fireEvent.click(screen.getByText('Get This Revision'))
    await flush()
    expect(queries.length).toBe(1)
    ledger[1]!(null)
    await flush()
    expect(queryArgs[1]).toMatchObject({ force: false })

    fireEvent.click(screen.getByTestId('perforceGraph-querySyncPoint'))
    await flush()
    expect(queryArgs[2]).toMatchObject({ force: true })
  })
})

describe('PerforceGraphEditor re-reads after a get', () => {
  function openChangeMenu(container: HTMLElement): void {
    fireEvent.contextMenu(container.querySelector('[data-id="4521"]')!)
  }

  /**
   * Every entry point that issues a get must re-read the graph itself: a `p4 sync`
   * advances have revisions without touching `p4 opened`, so the SCM observable the
   * auto-refresh rides on may never emit, and the sync badge keeps naming the old
   * row. Each case asserts the get reached the extension AND that a second
   * `getChanges` followed — the 5 payloads differ but share the one helper.
   *
   * The sync point is asserted alongside it because the badge now hangs off its
   * own commands: a revalidate that re-reads the list but never re-reads the
   * ledger would leave the badge on the pre-get row, which is precisely the bug
   * this table exists for. e2e cannot cover it (the SCM auto-refresh delivers a
   * reload anyway), so this chain is the only guard.
   */
  const CASES: readonly {
    name: string
    render: () => { commandService: ICommandService; container: HTMLElement }
    /** Picks the menu entry (or triggers the dialog). */
    act: (container: HTMLElement) => void
    /** Follow-up that needs the previous flush to have settled (dialog opened). */
    confirm?: () => void
    /** A scoped history, whose sync point is cheap enough to probe unasked. */
    scoped?: boolean
    command: string
    args: readonly unknown[]
  }[] = [
    {
      name: 'whole-repo Get This Revision',
      render: () => renderEditor(),
      act: (c) => {
        openChangeMenu(c)
        fireEvent.click(screen.getByText('Get This Revision'))
      },
      command: PerforceGraphCommands.syncToChange,
      args: [expect.objectContaining({ change: '4521', wholeRepo: false })],
    },
    {
      name: 'scoped Get This Revision',
      render: () => renderScopedEditor(SCOPED_PATHS),
      act: (c) => {
        openChangeMenu(c)
        fireEvent.click(screen.getByText('Get This Revision'))
      },
      scoped: true,
      command: PerforceGraphCommands.syncToChange,
      args: [expect.objectContaining({ change: '4521', scopePaths: SCOPED_PATHS })],
    },
    {
      name: 'scoped Get Latest Revision',
      render: () => renderScopedEditor(SCOPED_PATHS),
      act: (c) => {
        openChangeMenu(c)
        fireEvent.click(screen.getByText('Get Latest Revision'))
      },
      scoped: true,
      command: 'perforce.syncLatest',
      args: [
        expect.objectContaining({ resourceUri: 'X:/p4ws/main', isDirectory: true }),
        expect.anything(),
      ],
    },
    {
      name: 'Force Get from the change menu',
      render: () => renderEditor(),
      act: (c) => {
        openChangeMenu(c)
        fireEvent.click(screen.getByText('Force Get (Overwrite Local Files)'))
      },
      command: PerforceGraphCommands.syncToChange,
      args: [expect.objectContaining({ change: '4521', force: true })],
    },
    {
      name: 'Get Revision… dialog confirm',
      render: () => renderEditor(),
      act: (c) => {
        openChangeMenu(c)
        fireEvent.click(screen.getByText('Get Revision…'))
      },
      // The dialog's confirm button is the go-ahead; candidates come preselected.
      confirm: () => {
        const dialog = screen.getByTestId('perforceGraph-syncDialog')
        fireEvent.click(within(dialog).getByText(/^Get Revision \(/))
      },
      command: PerforceGraphCommands.syncToChange,
      args: [expect.objectContaining({ change: '4521', confirmed: true })],
    },
  ]

  for (const testCase of CASES) {
    it(`revalidates the graph once "${testCase.name}" resolves`, async () => {
      const { commandService, container } = testCase.render()
      await flush()
      const countCalls = (id: string): number =>
        (commandService.executeCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c) => c[0] === id,
        ).length
      // The ledger read is the badge's whole input now — a scoped history adds
      // its own cheap probe, a whole-graph scope never probes unasked.
      expect(countCalls(PerforceGraphCommands.getChanges)).toBe(1)
      expect(countCalls(PerforceGraphCommands.getSyncPoint)).toBe(1)
      expect(countCalls(PerforceGraphCommands.getHaveChange)).toBe(testCase.scoped ? 1 : 0)

      testCase.act(container)
      await flush()
      if (testCase.confirm) {
        testCase.confirm()
        await flush()
      }

      expect(commandService.executeCommand).toHaveBeenCalledWith(testCase.command, ...testCase.args)
      expect(countCalls(PerforceGraphCommands.getChanges)).toBe(2)
      // The extension writes the ledger BEFORE the sync command resolves, so
      // re-reading it here is what moves the badge onto the new row. A revalidate
      // that re-reads the list but never the ledger leaves the badge on the
      // pre-get row — the exact bug this table exists for.
      expect(countCalls(PerforceGraphCommands.getSyncPoint)).toBe(2)
      expect(countCalls(PerforceGraphCommands.getHaveChange)).toBe(testCase.scoped ? 2 : 0)
    })
  }
})
