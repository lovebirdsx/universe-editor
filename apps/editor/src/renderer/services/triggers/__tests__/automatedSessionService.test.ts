/*---------------------------------------------------------------------------------------------
 *  Tests for AutomatedSessionService: mode resolution / verification, elevated
 *  refusal, prompt dispatch, and the end-of-run hand-off (history + event).
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '@universe-editor/platform'
import type { ISettableObservable } from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption as SdkSessionConfigOption } from '@agentclientprotocol/sdk'
import type { IAcpAgentRegistry } from '../../acp/acpAgentRegistry.js'
import type { IAcpSessionHistoryService } from '../../acp/session/acpSessionHistory.js'
import type {
  AcpPendingElicitation,
  AcpPendingPermission,
  AcpSessionStatus,
  AcpUsage,
  IAcpSession,
} from '../../acp/session/acpSessionModel.js'
import type { IAcpSessionService } from '../../acp/session/acpSessionService.js'
import type { TriggerRunEnd, TriggerRunRequest } from '../../../../shared/triggers/types.js'
import { AutomatedSessionService } from '../automatedSessionService.js'
import { StubLoggerService } from '../../../__tests__/_helpers/stubLoggerService.js'

interface FakeSession {
  readonly session: IAcpSession
  readonly status: ISettableObservable<AcpSessionStatus>
  readonly configBag: ISettableObservable<readonly SdkSessionConfigOption[]>
  readonly prompts: string[]
  readonly close: ReturnType<typeof vi.fn>
  readonly cancelTurn: ReturnType<typeof vi.fn>
}

function modeOption(value: string): SdkSessionConfigOption {
  return {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: value,
    options: [{ value, name: value }],
  } as unknown as SdkSessionConfigOption
}

function makeFakeSession(initialMode: string, pendingPrompt = false): FakeSession {
  const status = observableValue<AcpSessionStatus>('test.status', 'idle')
  const configBag = observableValue<readonly SdkSessionConfigOption[]>('test.config', [
    modeOption(initialMode),
  ])
  const prompts: string[] = []
  const close = vi.fn(async () => undefined)
  const cancelTurn = vi.fn(async () => undefined)
  const session = {
    id: 'local-1',
    sessionIdOnAgent: observableValue<string | undefined>('test.sid', 'agent-1'),
    status: status as never,
    configOptions: configBag as never,
    usage: observableValue<AcpUsage | undefined>('test.usage', undefined) as never,
    pendingPermission: observableValue<AcpPendingPermission | undefined>(
      'test.pp',
      undefined,
    ) as never,
    pendingElicitation: observableValue<AcpPendingElicitation | undefined>(
      'test.pe',
      undefined,
    ) as never,
    whenConnected: async () => undefined,
    whenConfigOptionsSettled: async () => undefined,
    sendPrompt: async (text: string) => {
      prompts.push(text)
      status.set('running', undefined)
      if (pendingPrompt) await new Promise(() => undefined)
      status.set('idle', undefined)
    },
    close,
    cancelTurn,
  } as unknown as IAcpSession
  return { session, status, configBag, prompts, close, cancelTurn }
}

interface Harness {
  readonly service: AutomatedSessionService
  readonly createSession: ReturnType<typeof vi.fn>
  readonly setAutomationResult: ReturnType<typeof vi.fn>
  readonly readFileText: ReturnType<typeof vi.fn>
  readonly ends: TriggerRunEnd[]
}

function makeHarness(
  options: { initialMode?: string; resultRaw?: string; pendingPrompt?: boolean } = {},
): Harness {
  const fake = makeFakeSession(options.initialMode ?? 'default', options.pendingPrompt === true)
  const createSession = vi.fn(async () => fake.session)
  const sessions = { createSession } as unknown as IAcpSessionService
  const registry = { defaultAgentId: () => 'claude-code' } as unknown as IAcpAgentRegistry
  const setAutomationResult = vi.fn()
  const history = { setAutomationResult } as unknown as IAcpSessionHistoryService
  const readFileText = vi.fn(async () => options.resultRaw ?? '{"anything":true}')
  const files = { readFileText } as never
  const service = new AutomatedSessionService(
    sessions,
    registry,
    history,
    files,
    new StubLoggerService(),
  )
  const ends: TriggerRunEnd[] = []
  service.onDidEndRun((end) => ends.push(end))
  return { service, createSession, setAutomationResult, readFileText, ends }
}

function request(overrides: Partial<TriggerRunRequest> = {}): TriggerRunRequest {
  return {
    origin: {
      triggerId: 'trig',
      triggerName: 'Trigger',
      eventKey: 'event:1',
      runId: 'run-1',
    },
    cwd: '/repo',
    allowElevatedMode: false,
    prompt: 'do it',
    runDir: '/userData/triggers/runs/run-1',
    budget: { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 60 },
    allowedActions: [],
    approveConfirmed: false,
    payload: {},
    ...overrides,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('AutomatedSessionService.startAutomatedSession', () => {
  it('refuses an elevated requested mode without confirmation', async () => {
    const h = makeHarness()
    await expect(
      h.service.startAutomatedSession(request({ mode: 'bypassPermissions' })),
    ).rejects.toThrow(/elevated mode/)
    expect(h.createSession).not.toHaveBeenCalled()
  })

  it('accepts an elevated mode once the user confirmed it', async () => {
    const h = makeHarness({ initialMode: 'bypassPermissions' })
    const result = await h.service.startAutomatedSession(
      request({ mode: 'bypassPermissions', allowElevatedMode: true }),
    )
    expect(result.sessionId).toBe('local-1')
    expect(h.createSession).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        configDesiredOverrides: { mode: 'bypassPermissions' },
        automation: request().origin,
        automationRunDir: request().runDir,
        additionalDirectories: [request().runDir],
        activate: false,
      }),
    )
  })

  it('falls back to the conservative mode for the agent', async () => {
    const h = makeHarness({ initialMode: 'default' })
    await h.service.startAutomatedSession(request())
    expect(h.createSession).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({ configDesiredOverrides: { mode: 'default' } }),
    )
  })

  it('uses an explicit agent / mode / model / MCP pin', async () => {
    const h = makeHarness({ initialMode: 'read-only' })
    await h.service.startAutomatedSession(
      request({
        agentId: 'codex',
        mode: 'read-only',
        model: 'gpt-x',
        mcpServerNames: ['swarm'],
      }),
    )
    expect(h.createSession).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        mcpServerNames: ['swarm'],
        configDesiredOverrides: { mode: 'read-only', model: 'gpt-x' },
      }),
    )
  })

  it('closes the session and rejects when the agent applied a different mode', async () => {
    const fake = makeFakeSession('plan')
    const createSession = vi.fn(async () => fake.session)
    const service = new AutomatedSessionService(
      { createSession } as unknown as IAcpSessionService,
      { defaultAgentId: () => 'claude-code' } as unknown as IAcpAgentRegistry,
      { setAutomationResult: vi.fn() } as unknown as IAcpSessionHistoryService,
      { readFileText: vi.fn() } as never,
      new StubLoggerService(),
    )
    await expect(service.startAutomatedSession(request({ mode: 'default' }))).rejects.toThrow(
      /mode mismatch/,
    )
    expect(fake.close).toHaveBeenCalled()
    expect(fake.prompts).toEqual([])
  })

  it('rejects an elevated actual mode when no mode was requested', async () => {
    const fake = makeFakeSession('danger-full-access')
    const createSession = vi.fn(async () => fake.session)
    const service = new AutomatedSessionService(
      { createSession } as unknown as IAcpSessionService,
      { defaultAgentId: () => 'third-party' } as unknown as IAcpAgentRegistry,
      { setAutomationResult: vi.fn() } as unknown as IAcpSessionHistoryService,
      { readFileText: vi.fn() } as never,
      new StubLoggerService(),
    )
    await expect(service.startAutomatedSession(request())).rejects.toThrow(/elevated mode/)
    expect(fake.close).toHaveBeenCalled()
  })

  it('dispatches the prompt after the handshake and reports the run end', async () => {
    const h = makeHarness({ resultRaw: '{"verdict":"info"}' })
    const started = await h.service.startAutomatedSession(request())
    expect(started.sessionId).toBe('local-1')
    await flush()
    expect(h.ends).toHaveLength(1)
    expect(h.ends[0]).toMatchObject({ runId: 'run-1', sessionId: 'agent-1', outcome: 'completed' })
    expect(h.setAutomationResult).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ outcome: 'completed' }),
    )
  })

  it('feeds the raw result.json through the installed resolver', async () => {
    const h = makeHarness({ resultRaw: '{"verdict":"escalate","summary":"look"}' })
    h.service.setVerdictResolver((raw) => ({
      verdict: 'escalate',
      summary: String(raw),
      actions: [],
    }))
    await h.service.startAutomatedSession(request())
    await flush()
    expect(h.ends[0]).toMatchObject({ verdict: 'escalate', outcome: 'completed' })
    expect(h.setAutomationResult).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ verdict: 'escalate', outcome: 'completed' }),
    )
  })

  it('cancelRun cancels an in-flight run', async () => {
    const h = makeHarness({ pendingPrompt: true })
    await h.service.startAutomatedSession(request())
    h.service.cancelRun('run-1')
    await flush()
    expect(h.ends[0]!.outcome).toBe('cancelled')
  })

  it('rejects a duplicate run id', async () => {
    const h = makeHarness({ pendingPrompt: true })
    await h.service.startAutomatedSession(request())
    await expect(h.service.startAutomatedSession(request())).rejects.toThrow(/already started/)
  })
})
