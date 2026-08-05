import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { swarmReviewsViewState } from '../../../services/swarm/swarmViewState.js'
import { swarmIgnoreStore } from '../../../services/swarm/swarmIgnoreStore.js'
import { buildSwarmReviewUrl } from '../../../services/swarm/swarmReviewUrl.js'
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
): InstantiationService {
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
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn().mockResolvedValue(undefined),
  } as never)
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
  return new InstantiationService(services)
}

afterEach(() => {
  cleanup()
  swarmReviewsViewState.dashboard = null
  swarmReviewsViewState.transitions = {}
  swarmReviewsViewState.transitionsSeenUpdated = {}
  for (const id of swarmIgnoreStore.list()) swarmIgnoreStore.unignore(id)
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
      <ServicesContext.Provider value={createServices(executeCommand)}>
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

  it('heals a stale ignore-snapshot (blank description) via a one-shot detail fetch', async () => {
    // Regression: a review ignored before blank-first-line descriptions were
    // parsed correctly has '' frozen as its snapshot description; the dashboard
    // no longer returns it, so the IGNORED group rendered "(no description)".
    swarmIgnoreStore.ignore({ ...review, id: '7769693', description: '' })
    const detail: SwarmReviewDetailDto = {
      id: '7769693',
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
      <ServicesContext.Provider value={createServices(executeCommand)}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )

    expect(await screen.findByText('Healed summary')).toBeTruthy()
    await waitFor(() =>
      expect(swarmIgnoreStore.getMeta('7769693')?.description).toBe('Healed summary'),
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
      <ServicesContext.Provider value={createServices(executeCommand)}>
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
        value={createServices(executeCommand, { configValues: { 'perforce.swarm.url': '' } })}
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
      <ServicesContext.Provider value={createServices(executeCommand, { sourceControls: [] })}>
        <SwarmReviewsView />
      </ServicesContext.Provider>,
    )

    expect(await screen.findByText('Not a Perforce workspace.')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.dashboard, expect.anything())
    expect(screen.queryByTestId('swarm-needs-action-filter')).toBeNull()
  })
})
