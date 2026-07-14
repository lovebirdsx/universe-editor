import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorService,
  IOpenerService,
  IQuickInputService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmDashboardResult,
  type SwarmReviewDto,
} from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import { swarmReviewsViewState } from '../../../services/swarm/swarmViewState.js'
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

function createServices(executeCommand: ReturnType<typeof vi.fn>): InstantiationService {
  const services = new ServiceCollection()
  services.set(ICommandService, { _serviceBrand: undefined, executeCommand } as never)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: (key: string) =>
      key === 'perforce.swarm.url' ? 'https://swarm.example.test/' : undefined,
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
  return new InstantiationService(services)
}

afterEach(() => {
  cleanup()
  swarmReviewsViewState.dashboard = null
  swarmReviewsViewState.keyword = ''
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
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.getTransitions, '1001')

    fireEvent.click(approve)
    await waitFor(() =>
      expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.transition, {
        reviewId: '1001',
        state: 'approved',
      }),
    )
  })
})
