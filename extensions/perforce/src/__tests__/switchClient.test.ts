/**
 * The switch-workspace flow is a chain of "easy to miss one step" wirings: a
 * missed `setActive` leaves argument-less commands on the old client, a missed
 * scope application leaves the old focus scope. These tests pin the whole
 * sequence — in order — and the quick-pick flow around it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerforceClient } from '../client.js'
import type { SwitchClientWiring } from '../switchClient.js'

const windowMock = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  showErrorMessage: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  window: windowMock,
}))

const { wireSwitchedClient, switchClient, clientPicks } = await import('../switchClient.js')

function makeWiring(log: string[]): SwitchClientWiring {
  return {
    add: (c) => log.push(`add:${c.root}`),
    setActive: (r) => log.push(`setActive:${r}`),
    statusBarRefresh: () => log.push('statusBarRefresh'),
    trackClient: (c) => log.push(`trackClient:${c.root}`),
    applyScopes: async (c) => {
      log.push(`applyScopes:${c.root}`)
    },
    applyExcludes: async (c) => {
      log.push(`applyExcludes:${c.root}`)
    },
    applyOpenedByOthersOptions: async (c) => {
      log.push(`applyOpenedByOthersOptions:${c.root}`)
    },
    startPolling: (c, s) => log.push(`startPolling:${c.root}:${s}`),
    setSwarmAvailable: (c, a) => log.push(`setSwarmAvailable:${c.root}:${a}`),
  }
}

describe('wireSwitchedClient', () => {
  it('runs the full activate sequence in order, with scopes before restore and options before refresh', async () => {
    const log: string[] = []
    const client = {
      root: 'X:/p4ws/branch_a',
      refresh: vi.fn(() => {
        log.push('refresh')
        return Promise.resolve()
      }),
    } as unknown as PerforceClient

    await wireSwitchedClient(
      client,
      { refreshIntervalSec: 120, swarmAvailable: true },
      makeWiring(log),
    )

    expect(log).toEqual([
      'add:X:/p4ws/branch_a',
      'setActive:X:/p4ws/branch_a',
      'statusBarRefresh',
      'trackClient:X:/p4ws/branch_a',
      // Scopes before the first refresh: the narrowed working-tree-hint scope
      // must be in place before the client answers any hint query.
      'applyScopes:X:/p4ws/branch_a',
      // Excludes directly after scopes: without them the client would scan and
      // collect inside excluded directories until the next config change.
      'applyExcludes:X:/p4ws/branch_a',
      // Background-check option BEFORE the first refresh: the refresh tail's
      // scheduled check reads it and would silently skip on defaults.
      'applyOpenedByOthersOptions:X:/p4ws/branch_a',
      'refresh',
      'startPolling:X:/p4ws/branch_a:120',
      'setSwarmAvailable:X:/p4ws/branch_a:true',
      // The second refresh applies the just-set swarm availability, mirroring
      // activate's setSwarmAvailable + refresh pair.
      'refresh',
    ])
  })
})

describe('switchClient', () => {
  const entry = { clientName: 'otherclient', clientRoot: 'X:/p4ws/branch_a' }

  function makeDeps(overrides: Record<string, unknown> = {}) {
    const current = {
      clientName: 'testclient',
      root: 'X:/p4ws/main',
      listUserClients: vi.fn(async () => [entry]),
    }
    return {
      mgr: { active: current } as never,
      createClient: vi.fn(() => ({ root: 'X:/p4ws/branch_a' }) as PerforceClient),
      wire: vi.fn<(client: PerforceClient) => Promise<void>>(async () => {}),
      log: undefined,
      ...overrides,
    }
  }

  beforeEach(() => {
    windowMock.showQuickPick.mockReset()
    windowMock.showErrorMessage.mockReset()
  })

  it('creates and wires a client for the picked entry', async () => {
    windowMock.showQuickPick.mockResolvedValue({
      label: 'otherclient',
      description: 'X:/p4ws/branch_a',
    })
    const deps = makeDeps()
    await switchClient(deps as never)

    expect(deps.createClient).toHaveBeenCalledWith(entry)
    expect(deps.wire).toHaveBeenCalledTimes(1)
    const wired = deps.wire.mock.calls[0]?.[0]
    expect(wired?.root).toBe('X:/p4ws/branch_a')
    // The current client is marked with a check in the pick.
    const picks = windowMock.showQuickPick.mock.calls[0]?.[0] as {
      label: string
      iconId?: string
    }[]
    expect(picks.map((p) => p.label)).toEqual(['testclient', 'otherclient'])
    expect(picks[0]?.iconId).toBe('check')
    expect(picks[1]?.iconId).toBeUndefined()
  })

  it('does nothing when the current client is picked', async () => {
    windowMock.showQuickPick.mockResolvedValue({ label: 'testclient' })
    const deps = makeDeps()
    await switchClient(deps as never)

    expect(deps.createClient).not.toHaveBeenCalled()
    expect(deps.wire).not.toHaveBeenCalled()
  })

  it('does nothing when the pick is cancelled', async () => {
    windowMock.showQuickPick.mockResolvedValue(undefined)
    const deps = makeDeps()
    await switchClient(deps as never)

    expect(deps.createClient).not.toHaveBeenCalled()
    expect(deps.wire).not.toHaveBeenCalled()
  })

  it('reports a failure when no clients can be listed', async () => {
    const deps = makeDeps({
      mgr: {
        active: {
          clientName: 'testclient',
          root: 'X:/p4ws/main',
          listUserClients: vi.fn(async () => []),
        },
      },
    })
    await switchClient(deps as never)

    expect(windowMock.showErrorMessage).toHaveBeenCalled()
    expect(windowMock.showQuickPick).not.toHaveBeenCalled()
  })

  it('returns without doing anything when there is no active client', async () => {
    const deps = makeDeps({ mgr: { active: undefined } })
    await switchClient(deps as never)

    expect(windowMock.showQuickPick).not.toHaveBeenCalled()
    expect(deps.createClient).not.toHaveBeenCalled()
  })

  it('prepends the current client when the listing omits it', async () => {
    const deps = makeDeps({
      mgr: {
        active: {
          clientName: 'testclient',
          root: 'X:/p4ws/main',
          listUserClients: vi.fn(async () => [entry]),
        },
      },
    })
    windowMock.showQuickPick.mockResolvedValue(undefined)
    await switchClient(deps as never)

    const picks = windowMock.showQuickPick.mock.calls[0]?.[0] as { label: string }[]
    expect(picks[0]?.label).toBe('testclient')
  })
})

describe('clientPicks', () => {
  it('shows the root as the description (which branch a client maps) and the client description as detail', () => {
    const picks = clientPicks(
      [
        { clientName: 'testclient', clientRoot: 'X:\\p4ws\\main', description: 'Main line.' },
        { clientName: 'otherclient', clientRoot: 'X:\\p4ws\\branch_a' },
      ],
      'testclient',
    )
    expect(picks).toEqual([
      {
        label: 'testclient',
        description: 'X:\\p4ws\\main',
        detail: 'Main line.',
        iconId: 'check',
      },
      { label: 'otherclient', description: 'X:\\p4ws\\branch_a' },
    ])
  })
})
