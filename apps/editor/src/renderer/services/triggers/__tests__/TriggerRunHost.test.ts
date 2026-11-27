/*---------------------------------------------------------------------------------------------
 *  Tests for TriggerRunHost: delegation to the automated-session service, run-end
 *  reporting to main (best effort), trust probing behind the initialization
 *  barrier, and subscription lifetime.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  LogLevel,
  URI,
  type ILogger,
  type ILoggerService,
  type IWorkspaceService,
  type IWorkspaceTrustManagementService,
} from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import type {
  ITriggerMainService,
  TriggerPollPreview,
} from '../../../../shared/ipc/triggerService.js'
import type {
  TriggerRunEnd,
  TriggerRunHistoryEntry,
  TriggerRunReportReadResult,
  TriggerRunRequest,
  TriggerSummary,
} from '../../../../shared/triggers/types.js'
import type {
  AutomatedRunStartResult,
  IAutomatedSessionService,
} from '../automatedSessionService.js'
import type { IUserSettingsSyncService } from '../../configuration/UserSettingsSync.js'
import type { ITriggerSessionRevealService } from '../triggerSessionRevealService.js'
import { TriggerRunHost } from '../TriggerRunHost.js'

function makeRequest(runId = 'run-1', showSession = false): TriggerRunRequest {
  return {
    origin: { triggerId: 'triage', triggerName: 'Triage', eventKey: 'swarm:1', runId },
    showSession,
    cwd: 'X:/workspace',
    allowElevatedMode: false,
    prompt: 'do the thing',
    promptForSystemContract: 'do the thing (system)',
    eventPayload: {},
    runDir: 'X:/workspace/run',
    budget: { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 60 },
  }
}

function makeEnd(runId = 'run-1'): TriggerRunEnd {
  return { runId, triggerId: 'triage', outcome: 'completed' }
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

  fireEnd(end: TriggerRunEnd): void {
    this._onDidEndRun.fire(end)
  }
}

class FakeReveal implements ITriggerSessionRevealService {
  declare readonly _serviceBrand: undefined
  readonly revealOnRunStart = vi.fn((_sessionId: string, _showSession: boolean): void => undefined)
}

interface FakeUserSettings {
  readonly service: IUserSettingsSyncService
  resolveInitialized: () => void
}

function makeUserSettings(): FakeUserSettings {
  let resolve!: () => void
  const initialized = new Promise<void>((r) => {
    resolve = r
  })
  const service = {
    whenInitialized: initialized,
    initialize: async (): Promise<void> => undefined,
  } as unknown as IUserSettingsSyncService
  return { service, resolveInitialized: () => resolve() }
}

class FakeTriggerMain implements ITriggerMainService {
  declare readonly _serviceBrand: undefined
  readonly _onDidChangeTriggers = new Emitter<readonly TriggerSummary[]>()
  readonly onDidChangeTriggers = this._onDidChangeTriggers.event
  readonly reportRunEnd = vi.fn(async (_end: TriggerRunEnd): Promise<void> => undefined)
  readonly listTriggers = vi.fn(async (): Promise<readonly TriggerSummary[]> => [])
  readonly listRuns = vi.fn(async (): Promise<readonly TriggerRunHistoryEntry[]> => [])
  readonly getRun = vi.fn(
    async (_runId: string): Promise<TriggerRunHistoryEntry | undefined> => undefined,
  )
  readonly listWorkspaces = vi.fn(async () => [])
  readonly getRunsDir = vi.fn(async (): Promise<string> => 'X:/workspace/triggers/runs')
  readonly setMaxConcurrentRuns = vi.fn(async (): Promise<void> => undefined)
  readonly runNow = vi.fn(async (): Promise<void> => undefined)
  readonly previewPollEvents = vi.fn(
    async (): Promise<TriggerPollPreview> => ({ kind: 'unsupported' }),
  )
  readonly setPaused = vi.fn(async (): Promise<void> => undefined)
  readonly setAllPaused = vi.fn(async (): Promise<void> => undefined)
  readonly clearLastError = vi.fn(async (): Promise<void> => undefined)
  readonly confirmActivation = vi.fn(async (): Promise<void> => undefined)
  readonly ensureConfigFile = vi.fn(async (): Promise<string> => 'file:///triggers.json')
  readonly reportTriggerEvents = vi.fn(async () => undefined)
  readonly rescanWorkspace = vi.fn(async (): Promise<void> => undefined)
  readonly markHostReady = vi.fn(async (_workspace: string): Promise<void> => undefined)
  readonly removeWorkspace = vi.fn(async (): Promise<void> => undefined)
  readonly readRunReport = vi.fn(
    async (): Promise<TriggerRunReportReadResult> => ({ kind: 'not-found' }),
  )
}

interface FakeTrust {
  readonly service: IWorkspaceTrustManagementService
  readonly initialized: Promise<void>
  resolveInitialized: () => void
  trusted: boolean
  /** Per-URI answers; anything else falls back to `trusted`. */
  readonly uriTrust: Map<string, boolean>
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
    uriTrust: new Map(),
  }
  const service = {
    workspaceTrustInitialized: initialized,
    isWorkspaceTrusted: (): boolean => state.trusted,
    getUriTrustInfo: (uri: URI) => ({
      uri,
      trusted: state.uriTrust.get(uri.toString()) ?? state.trusted,
    }),
  } as unknown as IWorkspaceTrustManagementService
  return Object.assign(state, { service })
}

interface FakeWorkspace {
  readonly service: IWorkspaceService
  readonly onDidChangeWorkspace: Emitter<IWorkspaceService['current']>
  resolveReady: () => void
  current: URI | undefined
}

function makeWorkspace(): FakeWorkspace {
  let resolve!: () => void
  const ready = new Promise<void>((r) => {
    resolve = r
  })
  const change = new Emitter<IWorkspaceService['current']>()
  const state = {
    current: undefined as URI | undefined,
    resolveReady: () => resolve(),
    onDidChangeWorkspace: change,
  }
  const service = {
    whenReady: ready,
    get current() {
      return state.current === undefined ? null : { folder: state.current, name: 'ws' }
    },
    onDidChangeWorkspace: change.event,
  } as unknown as IWorkspaceService
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
  workspace: FakeWorkspace
  userSettings: FakeUserSettings
  reveal: FakeReveal
  logger: CapturingLoggerService
} {
  const sessions = new FakeAutomatedSessions()
  const main = new FakeTriggerMain()
  const trust = makeTrust()
  const workspace = makeWorkspace()
  const userSettings = makeUserSettings()
  const reveal = new FakeReveal()
  const logger = new CapturingLoggerService()
  const host = new TriggerRunHost(
    sessions,
    main,
    workspace.service,
    trust.service,
    userSettings.service,
    reveal,
    logger,
  )
  return { host, sessions, main, trust, workspace, userSettings, reveal, logger }
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

  it('passes the trigger session display choice to the reveal service', async () => {
    const { host, reveal } = setup()
    await host.startRun(makeRequest('run-1', true))
    expect(reveal.revealOnRunStart).toHaveBeenCalledWith('session-1', true)
  })

  it('returns the started session even when revealing throws', async () => {
    const { host, reveal, logger } = setup()
    reveal.revealOnRunStart.mockImplementationOnce(() => {
      throw new Error('no such tab')
    })
    await expect(host.startRun(makeRequest())).resolves.toEqual({ sessionId: 'session-1' })
    expect(logger.warnings).toEqual([expect.stringContaining('no such tab')])
  })

  it('cancels a run through the automated session service', async () => {
    const { host, sessions } = setup()
    await host.cancelRun('run-9')
    expect(sessions.cancelRun).toHaveBeenCalledWith('run-9')
  })

  it('waits for trust initialization before answering', async () => {
    const { host, trust } = setup()
    trust.trusted = true
    const answer = host.isWorkspaceTrusted('file:///workspace')
    let settled = false
    void answer.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    trust.resolveInitialized()
    await expect(answer).resolves.toBe(true)
  })

  it('judges trust by the trigger workspace URI, not the window folder', async () => {
    const { host, trust } = setup()
    trust.trusted = false
    trust.uriTrust.set('remote-ssh://dev/home/testuser/proj', true)
    trust.resolveInitialized()

    await expect(host.isWorkspaceTrusted('remote-ssh://dev/home/testuser/proj')).resolves.toBe(true)
    await expect(host.isWorkspaceTrusted('file:///other')).resolves.toBe(false)
  })

  it('acknowledges the run host once the workspace is known', async () => {
    const { main, workspace, userSettings } = setup()
    workspace.current = URI.file('X:/workspace')
    userSettings.resolveInitialized()
    expect(main.markHostReady).not.toHaveBeenCalled()

    workspace.resolveReady()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(main.markHostReady).toHaveBeenCalledWith(URI.file('X:/workspace').toString())
  })

  it('waits for user settings hydration before acknowledging the host', async () => {
    const { main, workspace, userSettings } = setup()
    workspace.current = URI.file('X:/workspace')
    workspace.resolveReady()
    await Promise.resolve()
    await Promise.resolve()
    expect(main.markHostReady).not.toHaveBeenCalled()

    userSettings.resolveInitialized()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(main.markHostReady).toHaveBeenCalledWith(URI.file('X:/workspace').toString())
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
