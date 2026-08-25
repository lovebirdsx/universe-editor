/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SubagentModelFooter tests — the Model popover footer for claude-code
 *  sessions: candidate rendering (inherit row + provider candidates + stale
 *  value pinning), the setSubagentModel writes (including the inherit=clear
 *  semantic), the silent-until-changed hint row, and the restart ordering
 *  (requestProcessRestart only after the write has resolved).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  IAiModelService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  Severity,
  type AiProviderEntry,
} from '@universe-editor/platform'
import {
  IClaudeConfigService,
  type ClaudeAgentSettings,
  type ClaudeSettings,
  type ClaudeSettingsPatch,
} from '../../../../shared/ipc/claudeConfigService.js'
import type { IAcpSession } from '../../../services/acp/session/acpSessionService.js'
import { SubagentModelFooter } from '../SubagentModelFooter.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

const GW_ENTRY: AiProviderEntry = {
  id: 'gw',
  apiKey: 'tok-1',
  baseUrl: 'https://gw.example.com',
  protocolMap: { 'anthropic-messages': ['claude-sonnet-4-6', 'deepseek-pro-v4'] },
}

function makeClaudeService(agentSettings: ClaudeAgentSettings) {
  let settings: ClaudeSettings = {}
  let stored = { ...agentSettings }
  const writes: ClaudeAgentSettings[] = []
  const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  const service = {
    _serviceBrand: undefined,
    async read(): Promise<ClaudeSettings> {
      return settings
    },
    async patch(p: ClaudeSettingsPatch): Promise<void> {
      let next = { ...settings }
      if (p.env) {
        const env = { ...(next.env ?? {}) }
        for (const [key, value] of Object.entries(p.env)) {
          if (value === null) delete env[key]
          else env[key] = value
        }
        if (Object.keys(env).length > 0) next = { ...next, env }
        else delete next.env
      }
      settings = next
    },
    async configPath(): Promise<string> {
      return '/home/u/.claude/settings.json'
    },
    async readAuthStatus() {
      return { loggedIn: false, expired: false }
    },
    async readAgentSettings(): Promise<ClaudeAgentSettings> {
      return stored
    },
    async writeAgentSettings(next: ClaudeAgentSettings): Promise<void> {
      writes.push(next)
      await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
      stored = next
    },
    async checkGatewayConnectivity(): Promise<boolean> {
      return true
    },
  } as unknown as IClaudeConfigService
  return {
    service,
    writes,
    /** Resolve the oldest in-flight writeAgentSettings call, if any. */
    flushWrite: () => pending.shift()?.resolve(),
    /** Reject the oldest in-flight writeAgentSettings call, if any. */
    failWrite: (err: Error) => pending.shift()?.reject(err),
  }
}

function setup(opts: {
  agentSettings: ClaudeAgentSettings
  entries?: readonly AiProviderEntry[]
  restart?: () => void
  notify?: (n: unknown) => void
}) {
  const claude = makeClaudeService(opts.agentSettings)
  const session = {
    requestProcessRestart: opts.restart ?? vi.fn(),
  } as unknown as IAcpSession
  const services = new ServiceCollection()
  services.set(IClaudeConfigService, claude.service)
  services.set(IAiModelService, {
    _serviceBrand: undefined,
    async getProviders() {
      return opts.entries ?? [GW_ENTRY]
    },
    async getModelKnowledge() {
      return {}
    },
  } as unknown as IAiModelService)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify: opts.notify ?? (() => ({ dispose: () => {}, update: () => {} })),
  } as unknown as INotificationService)
  const instantiation = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={instantiation}>
      <SubagentModelFooter session={session} />
    </ServicesContext.Provider>,
  )
  return { claude, session }
}

function option(label: string): HTMLElement {
  const el = screen.getByText(label).closest('[role="option"]') as HTMLElement | null
  expect(el).toBeTruthy()
  return el!
}

async function pick(label: string) {
  await act(async () => {
    fireEvent.mouseDown(screen.getByText(label))
  })
}

describe('SubagentModelFooter', () => {
  it('renders the inherit row plus the selected provider candidates', async () => {
    setup({ agentSettings: { authentication: 'gw' } })
    // A candidate row proves the provider registry AND the claude agent
    // settings have both loaded; before that only the inherit row renders.
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy())

    expect(option('Follow main model').getAttribute('aria-selected')).toBe('true')
    expect(option('claude-sonnet-4-6').getAttribute('aria-selected')).toBe('false')
    expect(option('deepseek-pro-v4').getAttribute('aria-selected')).toBe('false')
  })

  it('picks a candidate through setSubagentModel', async () => {
    const { claude, session } = setup({ agentSettings: { authentication: 'gw' } })
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy())

    await pick('claude-sonnet-4-6')
    claude.flushWrite()
    await act(async () => {})

    expect(claude.writes.at(-1)).toEqual({
      authentication: 'gw',
      subagentModel: 'claude-sonnet-4-6',
    })
    expect(session.requestProcessRestart).not.toHaveBeenCalled()
  })

  it('picking the inherit row clears the pick', async () => {
    const { claude } = setup({
      agentSettings: { authentication: 'gw', subagentModel: 'claude-sonnet-4-6' },
    })
    // Wait for a candidate row so the loaded current value is in effect —
    // picking before that would see `undefined` and early-return.
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy())

    await pick('Follow main model')
    claude.flushWrite()
    await act(async () => {})

    expect(claude.writes.at(-1)).toEqual({ authentication: 'gw' })
  })

  it('keeps a stale current value as a pinned top option', async () => {
    setup({ agentSettings: { authentication: 'gw', subagentModel: 'old-stale-model' } })
    await waitFor(() => expect(screen.getByText('old-stale-model')).toBeTruthy())

    expect(option('old-stale-model').getAttribute('aria-selected')).toBe('true')
    const options = screen.getAllByRole('option').map((n) => n.textContent)
    expect(options).toEqual([
      'Follow main model',
      'old-stale-model',
      'claude-sonnet-4-6',
      'deepseek-pro-v4',
    ])
  })

  it('stays silent until a change, then shows the restart hint', async () => {
    setup({ agentSettings: { authentication: 'gw' } })
    await waitFor(() => expect(screen.getByText('deepseek-pro-v4')).toBeTruthy())

    expect(screen.queryByTestId('acp-subagent-restart')).toBeNull()

    await pick('deepseek-pro-v4')
    expect(screen.getByText(/Takes effect next session/)).toBeTruthy()
    expect(screen.getByTestId('acp-subagent-restart')).toBeTruthy()
  })

  it('does not mark the footer as changed when picking the already-current value', async () => {
    const { claude } = setup({
      agentSettings: { authentication: 'gw', subagentModel: 'claude-sonnet-4-6' },
    })
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy())

    await pick('claude-sonnet-4-6')

    expect(screen.queryByTestId('acp-subagent-restart')).toBeNull()
    expect(claude.writes).toHaveLength(0)
  })

  it('requests the process restart only after the pick write has resolved', async () => {
    const restart = vi.fn()
    const { claude } = setup({ agentSettings: { authentication: 'gw' }, restart })
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy())

    await pick('claude-sonnet-4-6')
    expect(screen.getByTestId('acp-subagent-restart')).toBeTruthy()

    fireEvent.click(screen.getByTestId('acp-subagent-restart'))
    // The pick's write is still in flight — restarting now would spawn the new
    // process against the old env.
    expect(restart).not.toHaveBeenCalled()

    claude.flushWrite()
    await act(async () => {})
    expect(restart).toHaveBeenCalledTimes(1)
    // Only the pick wrote; the restart awaits that write rather than issuing a
    // redundant second one.
    expect(claude.writes).toHaveLength(1)
  })

  it('reports the write failure and skips the restart when persisting the pick rejects', async () => {
    const restart = vi.fn()
    const notify = vi.fn()
    const { claude } = setup({
      agentSettings: { authentication: 'gw' },
      restart,
      notify,
    })
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy())

    await pick('claude-sonnet-4-6')
    expect(screen.getByTestId('acp-subagent-restart')).toBeTruthy()

    claude.failWrite(new Error('disk full'))
    await act(async () => {})
    fireEvent.click(screen.getByTestId('acp-subagent-restart'))
    await act(async () => {})

    // Restarting on a failed write would spawn the new process against the old
    // env — the failure must surface and the restart must not happen.
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toMatchObject({
      severity: Severity.Error,
      message: expect.stringContaining('Could not save the sub-agent model'),
    })
    expect(restart).not.toHaveBeenCalled()
  })
})
