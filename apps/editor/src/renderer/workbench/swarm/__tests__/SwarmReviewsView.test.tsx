import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorService,
  IOpenerService,
  IQuickInputService,
  IStorageService,
  InstantiationService,
  observableValue,
  ServiceCollection,
  type IObservable,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmDashboardResult,
  type SwarmReviewDetailDto,
  type SwarmReviewDto,
} from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import {
  IScmService,
  type IScmSourceControlModel,
} from '../../../services/extensions/ScmService.js'
import {
  requestSwarmReviewsRefresh,
  swarmReviewsViewState,
} from '../../../services/swarm/swarmViewState.js'
import { swarmIgnoreStore } from '../../../services/swarm/swarmIgnoreStore.js'
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

function createServices(
  executeCommand: ReturnType<typeof vi.fn>,
  options: FakeServicesOptions = {},
): { instantiation: InstantiationService; openEditor: ReturnType<typeof vi.fn> } {
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
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: vi.fn().mockResolvedValue({ confirmed: true }),
  } as never)
  const openEditor = vi.fn().mockResolvedValue(undefined)
  services.set(IEditorService, { _serviceBrand: undefined, openEditor } as never)
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
  return { instantiation: new InstantiationService(services), openEditor }
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
})
