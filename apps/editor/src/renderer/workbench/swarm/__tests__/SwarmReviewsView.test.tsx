import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorService,
  INotificationService,
  IOpenerService,
  IQuickInputService,
  IStorageService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  UriIdentityService,
  URI,
  observableValue,
  type ICommand,
  type IObservable,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmDashboardResult,
  type SwarmReviewDetailDto,
  type SwarmReviewDto,
  type SwarmReviewFileDto,
} from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import {
  IScmService,
  type IScmSourceControlModel,
} from '../../../services/extensions/ScmService.js'
import {
  requestSwarmReviewsRefresh,
  swarmReviewDetailCache,
  swarmReviewsViewState,
} from '../../../services/swarm/swarmViewState.js'
import { swarmIgnoreStore } from '../../../services/swarm/swarmIgnoreStore.js'
import { swarmApplyStore } from '../../../services/swarm/swarmApplyStore.js'
import { swarmReviewsUiStore } from '../../../services/swarm/swarmReviewsUiStore.js'
import { buildSwarmReviewUrl } from '../../../services/swarm/swarmReviewUrl.js'
import { swarmChangesViewState } from '../swarmChangesViewState.js'
import { canApproveReview, swarmReviewName, SwarmReviewsView } from '../SwarmReviewsView.js'

const review: SwarmReviewDto = {
  id: '1001',
  state: 'needsReview',
  stateLabel: 'Needs Review',
  author: 'alice',
  description: 'Fix the renderer',
  upVotes: 0,
  downVotes: 0,
  commentCount: 0,
  openTaskCount: 0,
  testStatus: 'none',
  updated: Date.now(),
}

const dashboard: SwarmDashboardResult = {
  needsAction: [review],
  authored: [],
  participating: [],
}

interface FakeServicesOptions {
  configValues?: Record<string, unknown>
  sourceControls?: readonly IScmSourceControlModel[]
}

interface FakeServicesResult {
  instantiation: InstantiationService
  openEditor: ReturnType<typeof vi.fn>
  dialog: { confirm: ReturnType<typeof vi.fn> }
  notifications: { notify: ReturnType<typeof vi.fn> }
}

function createServices(
  executeCommand: ReturnType<typeof vi.fn>,
  options: FakeServicesOptions = {},
): FakeServicesResult {
  const {
    configValues = { 'perforce.swarm.url': 'https://swarm.example.test/' },
    sourceControls = [{ id: 'perforce' } as unknown as IScmSourceControlModel],
  } = options
  const services = new ServiceCollection()
  services.set(ICommandService, { _serviceBrand: undefined, executeCommand } as never)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: (key: string) => configValues[key],
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  } as never)
  const dialog = {
    _serviceBrand: undefined,
    confirm: vi.fn().mockResolvedValue({ confirmed: true }),
  }
  services.set(IDialogService, dialog as never)
  const openEditor = vi.fn().mockResolvedValue(undefined)
  services.set(IEditorService, { _serviceBrand: undefined, openEditor } as never)
  const notifications = {
    _serviceBrand: undefined,
    notify: vi.fn(),
  }
  services.set(INotificationService, notifications as never)
  services.set(IOpenerService, {
    _serviceBrand: undefined,
    open: vi.fn().mockResolvedValue(true),
  } as never)
  services.set(IQuickInputService, {
    _serviceBrand: undefined,
    pick: vi.fn().mockResolvedValue(undefined),
    createQuickPick: vi.fn(),
  } as never)
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as never)
  services.set(IUriIdentityService, new UriIdentityService('win32'))
  services.set(IWorkspaceService, {
    _serviceBrand: undefined,
    current: { folder: URI.file('C:/workspace') },
  } as never)
  const sourceControlsObs: IObservable<readonly IScmSourceControlModel[]> = observableValue(
    'sourceControls',
    sourceControls,
  )
  services.set(IScmService, {
    _serviceBrand: undefined,
    sourceControls: sourceControlsObs,
    changeInputBoxValue() {},
    setExtHost() {},
    resetSourceControls() {},
  } as never)
  return { instantiation: new InstantiationService(services), openEditor, dialog, notifications }
}

/** The tree container is the keyboard target; every nav test drives it. */
function reviewsTree(): HTMLElement {
  return screen.getByRole('tree', { name: 'Swarm reviews' })
}

afterEach(() => {
  cleanup()
  swarmReviewsViewState.dashboard = null
  swarmReviewsViewState.transitions = {}
  swarmReviewsViewState.transitionsSeenUpdated = {}
  swarmReviewDetailCache.clear()
  swarmApplyStore.setIncludeOutside(false)
  swarmApplyStore.setIntoChangelist(true)
  for (const id of swarmIgnoreStore.list()) swarmIgnoreStore.unignore(id)
  swarmChangesViewState._resetForTests()
  for (const key of ['needsAction', 'ignored', 'authored'] as const) {
    swarmReviewsUiStore.setCollapsed(key, false)
  }
  vi.restoreAllMocks()
})

describe('SwarmReviewsView helpers', () => {
  it('builds review URLs and detects server-authorized approve transitions', () => {
    expect(buildSwarmReviewUrl('https://swarm.example.test/', '10/01')).toBe(
      'https://swarm.example.test/reviews/10%2F01',
    )
    expect(canApproveReview([{ state: 'approved:commit', label: 'Approve and Commit' }])).toBe(true)
    expect(canApproveReview([{ state: 'needsRevision', label: 'Needs Revision' }])).toBe(false)
    expect(swarmReviewName({ ...review, description: '  ' })).toBe('Review #1001')
  })
})

describe('SwarmReviewsView', () => {
  it('shows the blue checked state and server transitions in the row context menu', async () => {
    const executeCommand = vi.fn(async (command: string) => {
      if (command === SwarmCommands.dashboard) return dashboard
      if (command === SwarmCommands.getTransitions) {
        return [{ state: 'approved', label: 'Approve' }]
      }
      return undefined
    })

    render(
      <ServicesContext.Provider value={createServices(executeCommand).instantiation}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )

    const row = await screen.findByTestId('swarm-review-row')
    await waitFor(() => expect(row.querySelector('.lucide-circle-check')).not.toBeNull())
    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })

    const approve = await screen.findByRole('menuitem', { name: 'Approve' })
    expect(screen.getByRole('menuitem', { name: 'Open Review in Browser' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Copy Review Name' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Copy Review Link' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Obliterate Review' })).toBeTruthy()
    // First fetch (nothing pinned yet): must NOT force through the host TTL cache.
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.getTransitions, '1001', false)

    fireEvent.click(approve)
    await waitFor(() =>
      expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.transition, {
        reviewId: '1001',
        state: 'approved',
      }),
    )
  })

  it('honors the force flag of refresh requests (soft poll-driven vs manual)', async () => {
    // The notification poll's rising edge requests a SOFT refresh (force:false —
    // its own force fetch just repopulated the host TTL cache), while the
    // title-bar manual refresh keeps forcing.
    const executeCommand = vi.fn(async (command: string) => {
      if (command === SwarmCommands.dashboard) return dashboard
      if (command === SwarmCommands.getTransitions) return []
      return undefined
    })

    render(
      <ServicesContext.Provider value={createServices(executeCommand).instantiation}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )
    await screen.findByTestId('swarm-review-row')

    const dashboardArgs = () =>
      (executeCommand.mock.calls as unknown as Array<[string, { force: boolean }]>)
        .filter((c) => c[0] === SwarmCommands.dashboard)
        .map((c) => c[1])

    await act(async () => {
      await requestSwarmReviewsRefresh(false)
    })
    expect(dashboardArgs().at(-1)).toMatchObject({ force: false })

    await act(async () => {
      await requestSwarmReviewsRefresh()
    })
    expect(dashboardArgs().at(-1)).toMatchObject({ force: true })
  })

  it('heals a stale ignore-snapshot (blank description) via a one-shot detail fetch', async () => {
    // Regression: a review ignored before blank-first-line descriptions were
    // parsed correctly has '' frozen as its snapshot description; the dashboard
    // no longer returns it, so the IGNORED group rendered "(no description)".
    swarmIgnoreStore.ignore({ ...review, id: '100693', description: '' })
    const detail: SwarmReviewDetailDto = {
      id: '100693',
      state: 'needsReview',
      stateLabel: 'Needs Review',
      author: 'alice',
      description: '\nHealed summary\nfull body',
      updated: Date.now(),
      versions: [],
      participants: [],
      transitions: [],
      commentCount: 0,
      openTaskCount: 0,
      testStatus: 'none',
    }
    const executeCommand = vi.fn(async (command: string) => {
      if (command === SwarmCommands.dashboard) {
        return { needsAction: [], authored: [], participating: [] } satisfies SwarmDashboardResult
      }
      if (command === SwarmCommands.getReview) return detail
      return undefined
    })

    render(
      <ServicesContext.Provider value={createServices(executeCommand).instantiation}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )

    expect(await screen.findByText('Healed summary')).toBeTruthy()
    await waitFor(() =>
      expect(swarmIgnoreStore.getMeta('100693')?.description).toBe('Healed summary'),
    )
  })

  it('refreshes a stale ignore-snapshot from a live dashboard row', async () => {
    swarmIgnoreStore.ignore({ ...review, id: '2002', description: '' })
    const live: SwarmReviewDto = { ...review, id: '2002', description: 'Live title' }
    const executeCommand = vi.fn(async (command: string) => {
      if (command === SwarmCommands.dashboard) {
        return {
          needsAction: [live],
          authored: [],
          participating: [],
        } satisfies SwarmDashboardResult
      }
      return undefined
    })

    render(
      <ServicesContext.Provider value={createServices(executeCommand).instantiation}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )

    expect(await screen.findByText('Live title')).toBeTruthy()
    await waitFor(() => expect(swarmIgnoreStore.getMeta('2002')?.description).toBe('Live title'))
  })

  it('shows the not-configured state and skips the dashboard load when the swarm URL is empty', async () => {
    const executeCommand = vi.fn(async () => dashboard)

    render(
      <ServicesContext.Provider
        value={
          createServices(executeCommand, { configValues: { 'perforce.swarm.url': '' } })
            .instantiation
        }
      >
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )

    expect(await screen.findByText('Swarm is not configured. Set perforce.swarm.url.')).toBeTruthy()
    // Give a potential (misguided) load a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.dashboard, expect.anything())
    expect(screen.queryByTestId('swarm-needs-action-filter')).toBeNull()
  })

  it('shows the unavailable state and skips the dashboard load without a perforce workspace', async () => {
    const executeCommand = vi.fn(async () => dashboard)

    render(
      <ServicesContext.Provider
        value={createServices(executeCommand, { sourceControls: [] }).instantiation}
      >
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )

    expect(await screen.findByText('Not a Perforce workspace.')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.dashboard, expect.anything())
    expect(screen.queryByTestId('swarm-needs-action-filter')).toBeNull()
  })
})

describe('SwarmReviewsView apply to local', () => {
  const detailWithArchive: SwarmReviewDetailDto = {
    id: '1001',
    state: 'needsReview',
    stateLabel: 'Needs Review',
    author: 'alice',
    description: 'Fix the renderer',
    updated: 1,
    versions: [
      { version: 1, change: '2001', pending: true, time: 1 },
      { version: 2, change: '2002', archiveChange: '2999', pending: true, time: 2 },
    ],
    participants: [],
    transitions: [],
    commentCount: 0,
    openTaskCount: 0,
    testStatus: 'none',
  }

  const detailWithoutArchive: SwarmReviewDetailDto = {
    ...detailWithArchive,
    versions: [{ version: 1, change: '2001', pending: true, time: 1 }],
  }

  const files: SwarmReviewFileDto[] = [
    {
      status: 'M',
      path: 'src/editor/a.ts',
      depotFile: '//depot/src/editor/a.ts',
      baseRevision: '1',
      localPath: 'C:/workspace/src/editor/a.ts',
    },
    {
      status: 'A',
      path: 'src/runtime/b.ts',
      depotFile: '//depot/src/runtime/b.ts',
      baseRevision: null,
      localPath: 'C:/workspace/src/runtime/b.ts',
    },
  ]

  function registerCommand(id: string, handler: ICommand['handler']) {
    return CommandsRegistry.registerCommand({ id, handler })
  }

  /** Forwards host commands to the real registry (so waitForSwarmCommand sees
   *  them) and answers the view's own data commands inline. */
  function hybridExecuteCommand() {
    return vi.fn(async (command: string, ...args: unknown[]) => {
      const cmd = CommandsRegistry.getCommand(command)
      if (cmd) return cmd.handler({ get: () => undefined } as never, ...args)
      if (command === SwarmCommands.dashboard) return dashboard
      if (command === SwarmCommands.getTransitions) return []
      return undefined
    })
  }

  async function clickApplyToLocal(executeCommand: ReturnType<typeof vi.fn>) {
    const services = createServices(executeCommand)
    render(
      <ServicesContext.Provider value={services.instantiation}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )
    const row = await screen.findByTestId('swarm-review-row')
    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })
    const item = await screen.findByRole('menuitem', { name: 'Apply to Local' })
    fireEvent.click(item)
    return services
  }

  it('offers Apply to Local between the Open group and Ignore in the row menu', async () => {
    const executeCommand = hybridExecuteCommand()
    render(
      <ServicesContext.Provider value={createServices(executeCommand).instantiation}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )
    const row = await screen.findByTestId('swarm-review-row')
    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })
    await screen.findByRole('menuitem', { name: 'Apply to Local' })
    const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent,
    )
    const applyIdx = labels.indexOf('Apply to Local')
    const browserIdx = labels.indexOf('Open Review in Browser')
    const ignoreIdx = labels.indexOf('Ignore Review')
    expect(applyIdx).toBeGreaterThan(browserIdx)
    expect(applyIdx).toBeLessThan(ignoreIdx)
  })

  it('applies the cached latest version without re-fetching the review', async () => {
    swarmReviewDetailCache.set('1001', detailWithArchive)
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
      skipped: [],
    }))
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => files)
    const getReview = registerCommand(SwarmCommands.getReview, () => detailWithArchive)
    const executeCommand = hybridExecuteCommand()
    try {
      await clickApplyToLocal(executeCommand)

      await waitFor(() =>
        expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.describeVersion, {
          change: '2999',
          immutable: true,
        }),
      )
      await waitFor(() =>
        expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.applyToLocal, {
          change: '2999',
          depotFiles: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
          intoChangelist: true,
        }),
      )
      // The detail cache answered — getReview never hit the wire.
      expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.getReview, expect.anything())
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('fetches a cold review and caches it before describing', async () => {
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
      skipped: [],
    }))
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => files)
    const getReview = registerCommand(SwarmCommands.getReview, () => detailWithArchive)
    const executeCommand = hybridExecuteCommand()
    try {
      await clickApplyToLocal(executeCommand)

      await waitFor(() =>
        expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.getReview, { reviewId: '1001' }),
      )
      await waitFor(() => expect(swarmReviewDetailCache.get('1001')).toBe(detailWithArchive))
      await waitFor(() =>
        expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.applyToLocal, expect.anything()),
      )
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('uses the author changelist without the immutable flag when the latest version has no archive shelf', async () => {
    const applyToLocal = registerCommand(SwarmCommands.applyToLocal, () => ({
      applied: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
      skipped: [],
    }))
    const describeVersion = registerCommand(SwarmCommands.describeVersion, () => files)
    const getReview = registerCommand(SwarmCommands.getReview, () => detailWithoutArchive)
    const executeCommand = hybridExecuteCommand()
    try {
      await clickApplyToLocal(executeCommand)

      await waitFor(() =>
        expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.describeVersion, {
          change: '2001',
        }),
      )
      await waitFor(() =>
        expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.applyToLocal, {
          change: '2001',
          depotFiles: ['//depot/src/editor/a.ts', '//depot/src/runtime/b.ts'],
          intoChangelist: true,
        }),
      )
    } finally {
      applyToLocal.dispose()
      describeVersion.dispose()
      getReview.dispose()
    }
  })

  it('toasts when the review is unavailable and never applies', async () => {
    const getReview = registerCommand(SwarmCommands.getReview, () => undefined)
    const executeCommand = hybridExecuteCommand()
    try {
      const { notifications } = await clickApplyToLocal(executeCommand)

      await waitFor(() =>
        expect(notifications.notify).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining('unavailable') }),
        ),
      )
      expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.applyToLocal, expect.anything())
    } finally {
      getReview.dispose()
    }
  })
})

describe('SwarmReviewsView keyboard', () => {
  const second: SwarmReviewDto = { ...review, id: '1002', description: 'Second review' }
  const twoReviews: SwarmDashboardResult = {
    needsAction: [review, second],
    authored: [],
    participating: [],
  }

  async function renderTree() {
    const executeCommand = vi.fn(async (command: string) => {
      if (command === SwarmCommands.dashboard) return twoReviews
      if (command === SwarmCommands.getTransitions) return []
      return undefined
    })
    const { instantiation, openEditor } = createServices(executeCommand)
    render(
      <ServicesContext.Provider value={instantiation}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )
    await screen.findAllByTestId('swarm-review-row')
    const tree = reviewsTree()
    // Landing focus seeds the cursor on the first review row.
    fireEvent.focus(tree)
    return { tree, openEditor, executeCommand }
  }

  it('moves between review rows with the arrow keys', async () => {
    const { tree } = await renderTree()

    // aria-selected is the row the tree considers current — assistive tech has
    // no other signal for it (the highlight is CSS only).
    const rowOf = (text: string) => screen.getByText(text).closest('[role="treeitem"]')
    await waitFor(() =>
      expect(rowOf('Fix the renderer')?.getAttribute('aria-selected')).toBe('true'),
    )
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    await waitFor(() => expect(swarmChangesViewState.selectedReviewId.get()).toBe('1002'))
    expect(rowOf('Second review')?.getAttribute('aria-selected')).toBe('true')
    expect(rowOf('Fix the renderer')?.getAttribute('aria-selected')).toBe('false')
    fireEvent.keyDown(tree, { key: 'ArrowUp' })
    await waitFor(() => expect(swarmChangesViewState.selectedReviewId.get()).toBe('1001'))
  })

  it('previews on Space and pins on Enter', async () => {
    const { tree, openEditor } = await renderTree()

    fireEvent.keyDown(tree, { key: ' ' })
    await waitFor(() => expect(openEditor).toHaveBeenCalled())
    expect(openEditor.mock.calls.at(-1)?.[1]).toEqual({ pinned: false, preserveFocus: true })

    openEditor.mockClear()
    fireEvent.keyDown(tree, { key: 'Enter' })
    await waitFor(() => expect(openEditor).toHaveBeenCalled())
    expect(openEditor.mock.calls.at(-1)?.[1]).toEqual({ pinned: true })
  })

  it('feeds the focused review to the Swarm Changes view', async () => {
    await renderTree()
    await waitFor(() => expect(swarmChangesViewState.selectedReviewId.get()).toBe('1001'))
  })

  it('folds a group with the arrow keys and persists it', async () => {
    const { tree } = await renderTree()

    // ArrowLeft from a review row steps to its group header, a second one folds it.
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    await waitFor(() => expect(swarmReviewsUiStore.collapsed.needsAction).toBe(true))
    expect(screen.queryByText('Fix the renderer')).toBeNull()

    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    await waitFor(() => expect(swarmReviewsUiStore.collapsed.needsAction).toBe(false))
    expect(screen.getByText('Fix the renderer')).toBeTruthy()
  })

  it('keeps the previous Swarm Changes selection when a group header is focused', async () => {
    const { tree } = await renderTree()
    await waitFor(() => expect(swarmChangesViewState.selectedReviewId.get()).toBe('1001'))

    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    // Focus is now on the group header — the file list must not blank out.
    expect(swarmChangesViewState.selectedReviewId.get()).toBe('1001')
  })

  it('opens the row menu with the ContextMenu key, already highlighted and drivable', async () => {
    const { tree } = await renderTree()
    await waitFor(() => expect(swarmChangesViewState.selectedReviewId.get()).toBe('1001'))

    fireEvent.keyDown(tree, { key: 'ContextMenu' })

    const menu = await screen.findByRole('menu')
    // A keyboard user has no pointer to aim, so the first entry opens highlighted
    // and Enter would run it outright.
    const active = () => menu.ownerDocument.querySelectorAll('[role="menuitem"][data-active]')
    expect(active()).toHaveLength(1)
    expect(active()[0]?.textContent).toBe('Open Review')
    expect(menu.getAttribute('aria-activedescendant')).toBeTruthy()

    // The arrow keys drive the menu and must not tear it down (the regression
    // this whole change exists for).
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowDown' })
    })
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(active()[0]?.textContent).not.toBe('Open Review')
  })

  it('leaves a mouse-opened menu unhighlighted', async () => {
    await renderTree()
    const row = (await screen.findAllByTestId('swarm-review-row'))[0]!

    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })

    await screen.findByRole('menu')
    // An unsolicited highlight would read as a pending action under a pointer
    // that isn't there.
    expect(document.querySelector('[role="menuitem"][data-active]')).toBeNull()
  })
})

describe('SwarmReviewsView soft refresh', () => {
  // The dashboard is re-fetched on a timer, so rows swap content under the
  // cursor without any user action. Two things must hold while that happens,
  // because a violation of either is what the window showed as doubled text:
  // the list holds exactly one row per node (never an old row left standing),
  // and selecting a row scrolls nothing but the tree itself — reveal used to
  // call `scrollIntoView`, which also scrolls every ancestor scroller
  // (`overflow: hidden` boxes included, since script may scroll them) in the
  // same frame the rows changed.
  const second: SwarmReviewDto = { ...review, id: '1002', description: 'Second review' }
  const arriving: SwarmReviewDto = { ...review, id: '1003', description: 'Arriving review' }

  function rowsByOffset(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  }

  /** Review rows only — group headers are nodes too (id `group:<key>`). */
  function reviewRowKeys(): Array<string | undefined> {
    return rowsByOffset()
      .filter((el) => el.dataset['testid'] === 'swarm-review-row')
      .map((el) => el.dataset['rowKey'])
  }

  async function renderAndRefresh(next: SwarmDashboardResult) {
    let payload: SwarmDashboardResult = {
      needsAction: [review, second],
      authored: [],
      participating: [],
    }
    const executeCommand = vi.fn(async (command: string) => {
      if (command === SwarmCommands.dashboard) return payload
      if (command === SwarmCommands.getTransitions) return []
      return undefined
    })
    render(
      <ServicesContext.Provider value={createServices(executeCommand).instantiation}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )
    await screen.findByText('Fix the renderer')

    payload = next
    await act(async () => {
      await requestSwarmReviewsRefresh(false)
    })
    return executeCommand
  }

  it('swaps the row at the head of the list and drops the one it displaced', async () => {
    await renderAndRefresh({
      needsAction: [arriving, review],
      authored: [],
      participating: [],
    })

    // Exactly one node per slot: the displaced row's text is gone from the DOM,
    // not merely hidden behind the new one.
    expect(screen.getByText('Arriving review')).toBeTruthy()
    expect(screen.getByText('Fix the renderer')).toBeTruthy()
    expect(screen.queryByText('Second review')).toBeNull()

    const rows = rowsByOffset()
    const keys = rows.map((el) => el.dataset['rowKey'])
    expect(new Set(keys).size).toBe(keys.length)
    expect(reviewRowKeys()).toEqual(['review:1003', 'review:1001'])
  })

  it('stacks the rows at strictly increasing offsets', async () => {
    await renderAndRefresh({
      needsAction: [arriving, review],
      authored: [],
      participating: [],
    })

    // The list is flat and absolutely positioned inside the spacer, so equal or
    // decreasing offsets are rows drawn on top of each other.
    const offsets = rowsByOffset().map((el) => Number.parseFloat(el.style.top))
    expect(offsets.every((top) => Number.isFinite(top))).toBe(true)
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]! - offsets[i - 1]!).toBeGreaterThan(0)
    }
  })

  it('selects the next row without dragging any ancestor scroller along', async () => {
    // `scrollIntoView` walks up and scrolls *every* ancestor scroller — the
    // `overflow: hidden` boxes included, since script may scroll them — in the
    // same frame the rows changed, which is what left the view painted twice.
    // happy-dom has no layout, so the offsets reveal computes are not meaningful
    // here; that half is asserted in workbench-ui's Tree.revealScroll.test.tsx,
    // which can pin the viewport height.
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    await renderAndRefresh({
      needsAction: [arriving, review],
      authored: [],
      participating: [],
    })

    const tree = reviewsTree()
    fireEvent.focus(tree)
    await waitFor(() => expect(swarmChangesViewState.selectedReviewId.get()).toBe('1003'))
    scrollIntoView.mockClear()

    fireEvent.keyDown(tree, { key: 'ArrowDown' })

    await waitFor(() => expect(swarmChangesViewState.selectedReviewId.get()).toBe('1001'))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
