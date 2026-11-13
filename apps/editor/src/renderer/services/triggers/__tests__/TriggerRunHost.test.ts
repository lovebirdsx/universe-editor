/*---------------------------------------------------------------------------------------------
 *  Tests for TriggerRunHost: delegation to the automated-session service, run-end
 *  reporting to main (best effort), trust probing behind the initialization
 *  barrier, and subscription lifetime.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  LogLevel,
  type ILogger,
  type ILoggerService,
  type IWorkspaceTrustManagementService,
} from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import type { ITriggerMainService } from '../../../../shared/ipc/triggerService.js'
import type {
  TriggerRunEnd,
  TriggerRunRequest,
  TriggerSummary,
} from '../../../../shared/triggers/types.js'
import type {
  AutomatedRunStartResult,
  IAutomatedSessionService,
} from '../automatedSessionService.js'
import { TriggerRunHost } from '../TriggerRunHost.js'

function makeRequest(runId = 'run-1'): TriggerRunRequest {
  return {
    origin: { triggerId: 'triage', triggerName: 'Triage', eventKey: 'swarm:1', runId },
    cwd: 'X:/workspace',
    allowElevatedMode: false,
    prompt: 'do the thing',
    runDir: 'X:/workspace/run',
    budget: { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 60 },
    allowedActions: [],
    approveConfirmed: false,
    payload: { reviewId: '1' },
  }
}

function makeEnd(runId = 'run-1'): TriggerRunEnd {
  return { runId, triggerId: 'triage', outcome: 'completed', actions: [] }
}

class FakeAutomatedSessions implements IAutomatedSessionService {
  declare readonly _serviceBrand: undefined
  readonly _onDidEndRun = new Emitter<TriggerRunEnd>()
  readonly onDidEndRun = this._onDidEndRun.event
  readonly startAutomatedSession = vi.fn(
    async (_request: TriggerRunRequest): Promise<AutomatedRunStartResult> => ({
      sessionId: 'session-1',
    }),
  )
  readonly cancelRun = vi.fn((_runId: string): void => undefined)
  readonly setVerdictResolver = vi.fn((_resolver: unknown): void => undefined)

  fireEnd(end: TriggerRunEnd): void {
    this._onDidEndRun.fire(end)
  }
}

class FakeTriggerMain implements ITriggerMainService {
  declare readonly _serviceBrand: undefined
  readonly _onDidChangeTriggers = new Emitter<readonly TriggerSummary[]>()
  readonly onDidChangeTriggers = this._onDidChangeTriggers.event
  readonly reportRunEnd = vi.fn(async (_end: TriggerRunEnd): Promise<void> => undefined)
  readonly listTriggers = vi.fn(async (): Promise<readonly TriggerSummary[]> => [])
  readonly runNow = vi.fn(async (): Promise<void> => undefined)
  readonly setPaused = vi.fn(async (): Promise<void> => undefined)
  readonly setAllPaused = vi.fn(async (): Promise<void> => undefined)
  readonly confirmElevatedMode = vi.fn(async (): Promise<void> => undefined)
  readonly confirmAutoApprove = vi.fn(async (): Promise<void> => undefined)
  readonly ensureConfigFile = vi.fn(async (): Promise<string> => 'file:///triggers.json')
  readonly getConfigFileUri = vi.fn(async (): Promise<string> => 'file:///triggers.json')
  readonly reportSwarmNeedsAction = vi.fn(async (): Promise<void> => undefined)
}

interface FakeTrust {
  readonly service: IWorkspaceTrustManagementService
  readonly initialized: Promise<void>
  resolveInitialized: () => void
  trusted: boolean
}

function makeTrust(): FakeTrust {
  let resolve!: () => void
  const initialized = new Promise<void>((r) => {
    resolve = r
  })
  const state: FakeTrust = {
    service: {} as IWorkspaceTrustManagementService,
    initialized,
    resolveInitialized: () => resolve(),
    trusted: false,
  }
  const service = {
    workspaceTrustInitialized: initialized,
    isWorkspaceTrusted: (): boolean => state.trusted,
  } as unknown as IWorkspaceTrustManagementService
  return Object.assign(state, { service })
}

class CapturingLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  readonly warnings: string[] = []

  createLogger(): ILogger {
    return {
      level: LogLevel.Info,
      onDidChangeLogLevel: () => ({ dispose: () => undefined }),
      setLevel: () => undefined,
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => {
        this.warnings.push(message)
      },
      error: () => undefined,
      flush: () => undefined,
      dispose: () => undefined,
    }
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

function setup(): {
  host: TriggerRunHost
  sessions: FakeAutomatedSessions
  main: FakeTriggerMain
  trust: FakeTrust
  logger: CapturingLoggerService
} {
  const sessions = new FakeAutomatedSessions()
  const main = new FakeTriggerMain()
  const trust = makeTrust()
  const logger = new CapturingLoggerService()
  const host = new TriggerRunHost(sessions, main, trust.service, logger)
  return { host, sessions, main, trust, logger }
}

describe('TriggerRunHost', () => {
  it('starts a run through the automated session service and returns its id', async () => {
    const { host, sessions } = setup()
    const request = makeRequest()
    await expect(host.startRun(request)).resolves.toEqual({ sessionId: 'session-1' })
    expect(sessions.startAutomatedSession).toHaveBeenCalledWith(request)
  })

  it('propagates start failures so main can count them as run failures', async () => {
    const { host, sessions } = setup()
    sessions.startAutomatedSession.mockRejectedValueOnce(new Error('mode mismatch'))
    await expect(host.startRun(makeRequest())).rejects.toThrow('mode mismatch')
  })

  it('cancels a run through the automated session service', async () => {
    const { host, sessions } = setup()
    await host.cancelRun('run-9')
    expect(sessions.cancelRun).toHaveBeenCalledWith('run-9')
  })

  it('waits for trust initialization before answering', async () => {
    const { host, trust } = setup()
    trust.trusted = true
    const answer = host.isWorkspaceTrusted()
    let settled = false
    void answer.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    trust.resolveInitialized()
    await expect(answer).resolves.toBe(true)
  })

  it('reports a finished run to main', async () => {
    const { sessions, main } = setup()
    const end = makeEnd()
    sessions.fireEnd(end)
    await Promise.resolve()
    expect(main.reportRunEnd).toHaveBeenCalledWith(end)
  })

  it('keeps running when reporting the end fails', async () => {
    const { sessions, main, logger } = setup()
    main.reportRunEnd.mockRejectedValueOnce(new Error('ipc gone'))
    sessions.fireEnd(makeEnd())
    await Promise.resolve()
    await Promise.resolve()
    expect(logger.warnings).toEqual([expect.stringContaining('ipc gone')])
  })

  it('stops reporting after dispose', async () => {
    const { host, sessions, main } = setup()
    host.dispose()
    sessions.fireEnd(makeEnd())
    await Promise.resolve()
    expect(main.reportRunEnd).not.toHaveBeenCalled()
  })
})
