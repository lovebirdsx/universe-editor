/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Server-side triggerPoll channel. Three host-bound pieces of the trigger
 *  pipeline for remote workspaces: run the user's poll command on the remote
 *  host, carve out / prune a per-client run directory the remote agent session
 *  can write to, and read back one run's report.md.
 *
 *  Paths are server-owned: the client sends ids only. Run directories live under
 *  `<dataDir>/triggers/runs/<clientId>/<runId>` (clientId = the editor
 *  installation id), so two editors sharing a remote host prune only their own
 *  runs. Every URI returned here is `file:` and the per-connection codec maps it
 *  back to the client's `remote-ssh:` authority.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  URI,
  createNamedLogger,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import {
  createPollCommandFetcher,
  isValidTriggerClientId,
  isValidTriggerRunId,
  pruneRunDirectories,
  SessionReportReader,
  type IRemoteTriggerService,
  type PollCommandFetcher,
  type TriggerPollRequest,
  type TriggerPollResult,
  type TriggerRunDirectoryOptions,
  type TriggerRunReportReadOptions,
  type TriggerRunReportReadResult,
} from '@universe-editor/node-services'
import { resolveTriggersRunsDir } from './serverPaths.js'

export interface RemoteTriggerServiceOptions {
  /** Daemon data dir (`--data-dir`); run directories hang off it. */
  readonly dataDir: string
  readonly loggerService: ILoggerService
  /** Test seam: replace the real shell execution. */
  readonly fetcher?: PollCommandFetcher
}

export class RemoteTriggerService implements IRemoteTriggerService {
  private readonly _runsRoot: string
  private readonly _log: ILogger
  private readonly _fetch: PollCommandFetcher

  constructor(options: RemoteTriggerServiceOptions) {
    this._runsRoot = resolveTriggersRunsDir(options.dataDir)
    this._log = createNamedLogger(options.loggerService, {
      id: 'triggerPoll',
      name: 'Trigger Poll',
    })
    this._fetch = options.fetcher ?? createPollCommandFetcher(this._log)
  }

  async poll(request: TriggerPollRequest): Promise<TriggerPollResult> {
    const { command, cwd, timeoutSec, keyField } = request
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('triggerPoll.poll: command must be a non-empty string')
    }
    if (typeof keyField !== 'string' || keyField === '') {
      throw new Error('triggerPoll.poll: keyField must be a non-empty string')
    }
    if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new Error(`triggerPoll.poll: invalid timeoutSec ${String(timeoutSec)}`)
    }
    if (!URI.isUri(cwd)) {
      throw new Error('triggerPoll.poll: cwd must be a URI')
    }
    // The codec already translated remote-ssh → file; anything else means the
    // caller sent a path the server cannot interpret as its own filesystem.
    if (cwd.scheme !== 'file') {
      throw new Error(`triggerPoll.poll: cwd must be a file URI, got '${cwd.scheme}'`)
    }
    let isDirectory = false
    try {
      isDirectory = (await fs.stat(cwd.fsPath)).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) {
      throw new Error(`triggerPoll.poll: cwd is not an existing directory: ${cwd.fsPath}`)
    }

    this._log.debug(`poll: running in ${cwd.fsPath} (timeout ${timeoutSec}s)`)
    const result = await this._fetch({ command, cwd: cwd.fsPath, timeoutSec, keyField })
    if (result.ok) {
      this._log.debug(`poll: ${result.items.length} item(s) in ${cwd.fsPath}`)
    } else {
      this._log.warn(`poll failed in ${cwd.fsPath}: ${result.error}`)
    }
    return result
  }

  async createRunDir(
    clientId: string,
    runId: string,
    options: TriggerRunDirectoryOptions,
  ): Promise<{ readonly runDir: URI }> {
    assertIds(clientId, runId)
    const runDir = join(this._clientDir(clientId), runId)
    await fs.mkdir(runDir, { recursive: true })
    const { removed } = await this._prune(clientId, options)
    this._log.debug(
      `created run dir ${clientId}/${runId} (pruned ${removed.length} old run director(ies))`,
    )
    return { runDir: URI.file(runDir) }
  }

  async cleanupRuns(
    clientId: string,
    options: TriggerRunDirectoryOptions,
  ): Promise<{ readonly removed: readonly string[] }> {
    assertIds(clientId)
    const { removed } = await this._prune(clientId, options)
    this._log.debug(`cleaned ${removed.length} run director(ies) for client ${clientId}`)
    return { removed }
  }

  async readReport(
    clientId: string,
    runId: string,
    options?: TriggerRunReportReadOptions,
  ): Promise<TriggerRunReportReadResult> {
    assertIds(clientId, runId)
    const maxBytes = options?.maxBytes
    if (
      maxBytes !== undefined &&
      (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0)
    ) {
      throw new Error(`triggerPoll.readReport: invalid maxBytes ${String(maxBytes)}`)
    }
    const clientDir = this._clientDir(clientId)
    const reader = new SessionReportReader({
      runsDir: clientDir,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      logger: this._log,
    })
    const result = await reader.read(runId)
    if (!result.ok) {
      this._log.debug(`report ${clientId}/${runId}: ${result.reason}`)
      return result
    }
    // Re-tag as a plain Uint8Array: a Buffer serializes through `toJSON` on the
    // JSON codec path, which would bypass the `$u8` byte envelope.
    return {
      ok: true,
      bytes: new Uint8Array(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength),
      runDir: URI.file(result.runDir),
      modifiedAt: result.modifiedAt,
    }
  }

  private _clientDir(clientId: string): string {
    return join(this._runsRoot, clientId)
  }

  private async _prune(
    clientId: string,
    options: TriggerRunDirectoryOptions,
  ): Promise<{ readonly removed: readonly string[] }> {
    // A malformed options object must fail loud rather than silently keep nothing.
    const raw = options as TriggerRunDirectoryOptions | undefined
    const keep = raw?.keep
    if (typeof keep !== 'number' || !Number.isFinite(keep) || keep < 1) {
      throw new Error(`triggerPoll: invalid keep ${String(keep)}`)
    }
    const rawProtected = raw?.protectedRunIds
    const protectedRunIds = new Set(
      (Array.isArray(rawProtected) ? rawProtected : []).filter((runId) =>
        isValidTriggerRunId(runId),
      ),
    )
    return pruneRunDirectories(this._clientDir(clientId), {
      keep: Math.floor(keep),
      protectedRunIds,
      logger: this._log,
    })
  }
}

function assertIds(clientId: string, runId?: string): void {
  if (!isValidTriggerClientId(clientId)) {
    throw new Error('triggerPoll: invalid clientId')
  }
  if (runId !== undefined && !isValidTriggerRunId(runId)) {
    throw new Error('triggerPoll: invalid runId')
  }
}
