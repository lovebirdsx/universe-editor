/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Execution backends for one trigger run / poll. The scheduler no longer branches on
 *  `authority !== undefined` for polling, run directories, reports or cwd: it asks the
 *  backend selected for the trigger. Local runs go through the local poll fetcher and
 *  filesystem; remote runs always resolve a *fresh* service proxy from
 *  IRemoteConnectionService.getServiceProxy (never a cached ProxyChannel proxy), so a
 *  stop / reconnect swaps the relay under the same stable proxy.
 *--------------------------------------------------------------------------------------------*/

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  normalizeRemoteAuthority,
  REMOTE_SCHEME,
  RemoteChannels,
  URI,
  type ILogger,
} from '@universe-editor/platform'
import {
  isValidTriggerRunId,
  pruneRunDirectories,
  type IRemoteTriggerService,
  type PollFetchResult,
  type SessionReportReader,
} from '@universe-editor/node-services'
import {
  MAX_TRIGGER_REPORT_BYTES,
  type TriggerRunReportReadResult,
  type TriggerSourceConfig,
} from '../../../shared/triggers/types.js'
import type { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import { remotePathFromUri } from '../remote/remoteUri.js'
import type { PollCommandFetcher } from './pollCommandFetcher.js'
import { RemoteIoUnavailableError } from './triggerErrors.js'
import { unrefTimer, type TriggerClock, type TriggerTimerHandle } from './triggerClock.js'
import type { RoutedTrigger } from './triggerTypes.js'

export type PollSourceConfig = Extract<TriggerSourceConfig, { type: 'poll' }>

export type BackendPollOutcome =
  | { readonly kind: 'result'; readonly result: PollFetchResult }
  | { readonly kind: 'skipped'; readonly reason: string }

export type BackendRunDirOutcome =
  | { readonly kind: 'ok'; readonly runDir: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** Minimal workspace identity handed to the backend on attach / detach. */
export interface TriggerBackendWorkspace {
  readonly workspace: string
  readonly workspaceUri: URI
}

export interface TriggerExecutionBackend {
  readonly remote: boolean
  /** Connection / capability gate, synchronous and side-effect free. */
  isAvailable(): boolean
  fetchPoll(trigger: RoutedTrigger, source: PollSourceConfig): Promise<BackendPollOutcome>
  /** Returns a host-native absolute run directory. */
  createRunDir(
    trigger: RoutedTrigger,
    runId: string,
    protectedRunIds: readonly string[],
  ): Promise<BackendRunDirOutcome>
  readReport(runId: string): Promise<TriggerRunReportReadResult>
  /** Host-native absolute cwd (`workspace + session.cwd`). */
  resolveCwd(trigger: RoutedTrigger): string
  attachWorkspace(entry: TriggerBackendWorkspace): void
  detachWorkspace(entry: TriggerBackendWorkspace): void
}

/** `remote-ssh` authority of a workspace URI, normalized; undefined for local folders. */
export function workspaceAuthorityOf(workspaceUri: URI): string | undefined {
  return workspaceUri.scheme === REMOTE_SCHEME
    ? normalizeRemoteAuthority(workspaceUri.authority)
    : undefined
}

export interface LocalExecutionBackendOptions {
  readonly fetchPollItems: PollCommandFetcher
  readonly runsDir: string
  readonly reportReader: SessionReportReader
  readonly maxRunDirectories: number
  readonly logger: ILogger
}

export class LocalExecutionBackend implements TriggerExecutionBackend {
  readonly remote = false
  private readonly _fetchPollItems: PollCommandFetcher
  private readonly _runsDir: string
  private readonly _reportReader: SessionReportReader
  private readonly _maxRunDirectories: number
  private readonly _logger: ILogger

  constructor(options: LocalExecutionBackendOptions) {
    this._fetchPollItems = options.fetchPollItems
    this._runsDir = options.runsDir
    this._reportReader = options.reportReader
    this._maxRunDirectories = options.maxRunDirectories
    this._logger = options.logger
  }

  isAvailable(): boolean {
    return true
  }

  async fetchPoll(trigger: RoutedTrigger, source: PollSourceConfig): Promise<BackendPollOutcome> {
    const result = await this._fetchPollItems({
      command: source.fetch.command,
      cwd: trigger.workspaceUri.fsPath,
      timeoutSec: source.fetch.timeoutSec,
      keyField: source.keyField,
    })
    return { kind: 'result', result }
  }

  async createRunDir(
    _trigger: RoutedTrigger,
    runId: string,
    protectedRunIds: readonly string[],
  ): Promise<BackendRunDirOutcome> {
    const runDir = join(this._runsDir, runId)
    await mkdir(runDir, { recursive: true })
    // Retention must never delete a directory whose run is still alive.
    await pruneRunDirectories(this._runsDir, {
      keep: this._maxRunDirectories,
      protectedRunIds: new Set(protectedRunIds),
      logger: this._logger,
    })
    return { kind: 'ok', runDir }
  }

  async readReport(runId: string): Promise<TriggerRunReportReadResult> {
    const result = await this._reportReader.read(runId)
    if (!result.ok) {
      return { kind: result.reason === 'too_large' ? 'too-large' : 'not-found' }
    }
    return {
      kind: 'ok',
      text: Buffer.from(result.bytes).toString('utf8'),
      runDir: URI.file(result.runDir).toString(),
      modifiedAt: result.modifiedAt,
    }
  }

  resolveCwd(trigger: RoutedTrigger): string {
    return join(trigger.workspaceUri.fsPath, trigger.session.cwd ?? '')
  }

  attachWorkspace(): void {}
  detachWorkspace(): void {}
}

export interface RemoteExecutionBackendOptions {
  readonly authority: string
  readonly logger: ILogger
  readonly clock: TriggerClock
  readonly connections: IRemoteConnectionService
  readonly clientId: () => Promise<string>
  readonly maxRunDirectories: number
  /** Extra wait on top of the poll command's own timeout before the RPC is abandoned. */
  readonly pollGraceMs: number
  /** Active / queued / pending run ids of this authority a prune must keep. */
  readonly protectedRunIdsForAuthority: () => readonly string[]
}

export class RemoteExecutionBackend implements TriggerExecutionBackend {
  readonly remote = true
  private readonly _authority: string
  private readonly _logger: ILogger
  private readonly _clock: TriggerClock
  private readonly _connections: IRemoteConnectionService
  private readonly _clientId: () => Promise<string>
  private readonly _maxRunDirectories: number
  private readonly _pollGraceMs: number
  private readonly _protectedRunIdsForAuthority: () => readonly string[]

  constructor(options: RemoteExecutionBackendOptions) {
    this._authority = normalizeRemoteAuthority(options.authority)
    this._logger = options.logger
    this._clock = options.clock
    this._connections = options.connections
    this._clientId = options.clientId
    this._maxRunDirectories = options.maxRunDirectories
    this._pollGraceMs = options.pollGraceMs
    this._protectedRunIdsForAuthority = options.protectedRunIdsForAuthority
  }

  isAvailable(): boolean {
    return this._connections.getState(this._authority) === 'connected'
  }

  async fetchPoll(trigger: RoutedTrigger, source: PollSourceConfig): Promise<BackendPollOutcome> {
    if (!this.isAvailable()) {
      return { kind: 'skipped', reason: `remote '${this._authority}' is not connected` }
    }
    const command = source.fetch
    const timeoutMs = Math.max(0, command.timeoutSec * 1000) + this._pollGraceMs
    this._logger.debug(
      `trigger ${trigger.id}: remote poll in ${trigger.workspace} (timeout ${command.timeoutSec}s)`,
    )
    try {
      const call = this._proxy().poll({
        command: command.command,
        cwd: trigger.workspaceUri,
        timeoutSec: command.timeoutSec,
        keyField: source.keyField,
      })
      const result = await this._race(call, timeoutMs)
      if (result === undefined) {
        return { kind: 'skipped', reason: `no answer within ${timeoutMs}ms` }
      }
      return { kind: 'result', result }
    } catch (err) {
      return { kind: 'skipped', reason: `transport error: ${describeError(err)}` }
    }
  }

  async createRunDir(
    _trigger: RoutedTrigger,
    runId: string,
    protectedRunIds: readonly string[],
  ): Promise<BackendRunDirOutcome> {
    // Resolve local prerequisites before the gate; the RPC itself is re-checked
    // synchronously so a disconnect during the await aborts instead of dialling.
    const clientId = await this._clientId()
    try {
      const { runDir } = await this._withRemote(() =>
        this._proxy().createRunDir(clientId, runId, {
          keep: this._maxRunDirectories,
          protectedRunIds,
        }),
      )
      const path = remotePathFromUri(runDir)
      this._logger.info(`run ${runId}: remote run directory ${path} (client ${clientId})`)
      return { kind: 'ok', runDir: path }
    } catch (err) {
      if (!this.isAvailable()) {
        return {
          kind: 'unavailable',
          reason: `remote '${this._authority}' disconnected while creating the run dir`,
        }
      }
      throw err
    }
  }

  async readReport(runId: string): Promise<TriggerRunReportReadResult> {
    if (!isValidTriggerRunId(runId)) return { kind: 'not-found' }
    if (!this.isAvailable()) return { kind: 'unavailable' }
    try {
      const clientId = await this._clientId()
      const result = await this._withRemote(() =>
        this._proxy().readReport(clientId, runId, { maxBytes: MAX_TRIGGER_REPORT_BYTES }),
      )
      if (!result.ok) {
        return { kind: result.reason === 'too_large' ? 'too-large' : 'not-found' }
      }
      return {
        kind: 'ok',
        text: Buffer.from(result.bytes).toString('utf8'),
        runDir: result.runDir.toString(),
        modifiedAt: result.modifiedAt,
      }
    } catch (err) {
      this._logger.warn(
        `run ${runId}: cannot read the remote report from '${this._authority}': ${describeError(err)}`,
      )
      return { kind: 'unavailable' }
    }
  }

  resolveCwd(trigger: RoutedTrigger): string {
    return remotePathFromUri(URI.joinPath(trigger.workspaceUri, trigger.session.cwd ?? ''))
  }

  // The connection service owns the per-authority lifecycle; these hooks keep the
  // catalog's attach / detach path uniform across backends.
  attachWorkspace(): void {}
  detachWorkspace(): void {}

  /** Fresh proxy per call: the connection service owns reuse and re-binding. */
  private _proxy(): IRemoteTriggerService {
    return this._connections.getServiceProxy<IRemoteTriggerService>(
      this._authority,
      RemoteChannels.TriggerPoll,
    )
  }

  private async _withRemote<T>(call: () => Promise<T>): Promise<T> {
    if (!this.isAvailable()) throw new RemoteIoUnavailableError(this._authority)
    return call()
  }

  private async _race(
    call: Promise<PollFetchResult>,
    timeoutMs: number,
  ): Promise<PollFetchResult | undefined> {
    let timedOut = false
    let timer: TriggerTimerHandle | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = this._clock.setTimeout(() => {
        timedOut = true
        resolve(undefined)
      }, timeoutMs)
      unrefTimer(timer)
    })
    const answered = call.then(
      (result) => (timedOut ? undefined : result),
      (err: unknown) => {
        if (timedOut) return undefined
        throw err
      },
    )
    const result = await Promise.race([answered, timeout])
    if (timer !== undefined) this._clock.clearTimeout(timer)
    return result
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
