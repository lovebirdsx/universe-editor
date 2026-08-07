import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IConfigurationService,
  INotificationService,
  IQuickInputService,
  InstantiationService,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { ConfigureAiFixAction } from '../agentModelActions.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpConfigOptionsCacheService } from '../../services/acp/session/acpConfigOptionsCache.js'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

interface Harness {
  readonly updates: Array<{ key: string; value: unknown; target: unknown }>
  readonly notifications: Array<{ severity: unknown; message: string }>
  readonly picks: Array<{ items: Array<{ id?: string; label: string }> }>
  queuePicks(...ids: Array<string | undefined>): void
  run(): Promise<void>
}

function makeHarness(opts: {
  settings?: Record<string, string>
  agents?: ReadonlyArray<{ id: string; name: string }>
  bag?: readonly SessionConfigOption[]
}): Harness {
  const settingsMap: Record<string, string> = {
    'acp.aiFix.agentId': 'codex',
    'acp.aiFix.model': '',
    'acp.aiFix.thoughtLevel': 'low',
    'acp.aiFix.mode': '',
    ...opts.settings,
  }
  const updates: Harness['updates'] = []
  const notifications: Harness['notifications'] = []
  const picks: Harness['picks'] = []
  const queuedIds: Array<string | undefined> = []

  const services = new ServiceCollection()
  services.set(IAcpAgentRegistry, {
    list: () => opts.agents ?? [{ id: 'codex', name: 'Codex' }],
  } as unknown as IAcpAgentRegistry)
  services.set(IConfigurationService, {
    get: (key: string) => settingsMap[key],
    update: async (key: string, value: unknown, target: unknown) => {
      updates.push({ key, value, target })
    },
  } as unknown as IConfigurationService)
  services.set(IAcpConfigOptionsCacheService, {
    get: () => opts.bag ?? [],
  } as unknown as IAcpConfigOptionsCacheService)
  services.set(IQuickInputService, {
    pick: async (items: Array<{ id?: string; label: string }>) => {
      picks.push({ items })
      const id = queuedIds.shift()
      if (id === undefined) return undefined
      return items.find((i) => i.id === id)
    },
  } as unknown as IQuickInputService)
  services.set(INotificationService, {
    notify: (n: { severity: unknown; message: string }) => {
      notifications.push(n)
      return { close: () => {} }
    },
  } as unknown as INotificationService)
  const inst = new InstantiationService(services)

  return {
    updates,
    notifications,
    picks,
    queuePicks: (...ids) => queuedIds.push(...ids),
    run: async () => {
      await inst.invokeFunction((accessor) =>
        Promise.resolve(CommandsRegistry.getCommand(ConfigureAiFixAction.ID)!.handler(accessor)),
      )
    },
  }
}

describe('ConfigureAiFixAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    vi.clearAllMocks()
  })

  const BAG: readonly SessionConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-5',
      options: [
        { value: 'gpt-5', name: 'GPT-5' },
        { value: 'gpt-5-codex', name: 'GPT-5 Codex' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'read-only',
      options: [{ value: 'read-only', name: 'Read Only' }],
    },
  ]

  it('writes each pick to the matching acp.aiFix.* key at the User target', async () => {
    disposables.push(registerAction2(ConfigureAiFixAction))
    const h = makeHarness({ bag: BAG })
    // Keep the current agent, then pick model / thought level / mode. 'low' is
    // already the stored thoughtLevel, so re-picking it is a no-op write.
    h.queuePicks('codex', 'gpt-5-codex', 'low', 'read-only')
    await h.run()

    expect(h.updates).toEqual([
      { key: 'acp.aiFix.model', value: 'gpt-5-codex', target: 2 },
      { key: 'acp.aiFix.mode', value: 'read-only', target: 2 },
    ])
    expect(h.notifications).toEqual([])
    // 1 agent pick + 3 option picks; the agent pick annotated the current row.
    expect(h.picks).toHaveLength(4)
    expect(h.picks[0]!.items.find((i) => i.id === 'codex')?.label).toContain('current')
  })

  it('cancelling a step keeps the values written so far', async () => {
    disposables.push(registerAction2(ConfigureAiFixAction))
    const h = makeHarness({
      bag: BAG,
      agents: [
        { id: 'codex', name: 'Codex' },
        { id: 'claude-code', name: 'Claude Code' },
      ],
    })
    // Change the agent, then cancel at the model step.
    h.queuePicks('claude-code', undefined)
    await h.run()

    expect(h.updates).toEqual([{ key: 'acp.aiFix.agentId', value: 'claude-code', target: 2 }])
    // The agent switch was written; the cancelled model pick wrote nothing.
    expect(h.notifications).toHaveLength(0)
    expect(h.picks).toHaveLength(2)
  })

  it('empty cache shows a single notification and writes nothing beyond the agent pick', async () => {
    disposables.push(registerAction2(ConfigureAiFixAction))
    const h = makeHarness({ bag: [] })
    h.queuePicks('codex')
    await h.run()

    expect(h.updates).toEqual([])
    expect(h.notifications).toHaveLength(1)
    expect(h.picks).toHaveLength(1)
  })

  it('picking the leading "(default)" row clears the setting back to follow-default', async () => {
    disposables.push(registerAction2(ConfigureAiFixAction))
    const h = makeHarness({
      settings: { 'acp.aiFix.model': 'gpt-5' },
      bag: BAG,
    })
    // Keep agent, clear model to follow-default, cancel the rest.
    h.queuePicks('codex', '', undefined)
    await h.run()

    expect(h.updates).toEqual([{ key: 'acp.aiFix.model', value: '', target: 2 }])
  })
})
