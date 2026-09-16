/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Server-side agent-binary channel. Resolves/downloads the native Claude /
 *  Codex binaries onto the remote host by wrapping the shared AgentBinaryStore
 *  (node-services) per agent. The stores are constructed lazily on first use so
 *  a fresh daemon never reads a meta file (or touches disk) until a session —
 *  or an explicit prefetch/cleanup — actually needs a binary. Download state is
 *  forwarded per agent, throttled before crossing the TCP tunnel — the store
 *  fires per chunk, which is far too chatty for a remote link (a multi-hundred-MB
 *  download is tens of thousands of events).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { Disposable, Emitter, type ILoggerService } from '@universe-editor/platform'
import {
  AgentBinaryStore,
  codexFlavor,
  createClaudeFlavor,
  type AgentBinaryDownloadState,
  type AgentBinaryId,
  type AgentBinaryRemoteDownloadEvent,
  type AgentBinaryVersionInfo,
  type IRemoteAgentBinaryService,
} from '@universe-editor/node-services'
import { resolveVendorFile } from './vendorAgentEntry.js'

const PROGRESS_THROTTLE_MS = 100

/** Test seam: build an AgentBinaryStore for a given agent/baseDir. */
export type AgentBinaryStoreFactory = (agent: AgentBinaryId, baseDir: string) => AgentBinaryStore

export interface RemoteAgentBinaryServiceOptions {
  readonly agentBinaryDir: string
  readonly loggerService: ILoggerService
  readonly createStore?: AgentBinaryStoreFactory
}

export class RemoteAgentBinaryService extends Disposable implements IRemoteAgentBinaryService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeDownload = this._register(
    new Emitter<AgentBinaryRemoteDownloadEvent>(),
  )
  readonly onDidChangeDownload = this._onDidChangeDownload.event

  private readonly _agentBinaryDir: string
  private readonly _loggerService: ILoggerService
  private readonly _createStore: AgentBinaryStoreFactory
  private readonly _stores: Partial<Record<AgentBinaryId, AgentBinaryStore>> = {}
  private readonly _lastForward = new Map<AgentBinaryId, number>()
  /** Last forwarded download set per agent — drives the begin/end transition check. */
  private readonly _lastShape = new Map<AgentBinaryId, string>()

  constructor(options: RemoteAgentBinaryServiceOptions) {
    super()
    this._agentBinaryDir = options.agentBinaryDir
    this._loggerService = options.loggerService
    this._createStore =
      options.createStore ?? ((agent, baseDir) => this._buildStore(agent, baseDir))
  }

  async resolve(
    agent: AgentBinaryId,
    opts: { readonly allowDownload?: boolean },
  ): Promise<{ readonly path: string }> {
    return { path: await this._storeFor(agent).resolveDownload(opts.allowDownload ?? true) }
  }

  async getVersionInfo(agent: AgentBinaryId): Promise<AgentBinaryVersionInfo> {
    return this._storeFor(agent).getVersionInfo()
  }

  async forceDownload(agent: AgentBinaryId, version: string): Promise<{ readonly path: string }> {
    return { path: await this._storeFor(agent).forceDownload(version) }
  }

  async prefetch(agent: AgentBinaryId): Promise<void> {
    await this._storeFor(agent).prefetch()
  }

  async cleanupStaleVersions(agent: AgentBinaryId): Promise<void> {
    await this._storeFor(agent).cleanupStaleVersions()
  }

  private _storeFor(agent: AgentBinaryId): AgentBinaryStore {
    let store = this._stores[agent]
    if (!store) {
      // Binaries live under a non-versioned `<dataDir>/agent-bin/<agent>` tree —
      // deliberately outside the per-server-version dir so a server upgrade /
      // redeploy never re-downloads hundreds of MB of native binary.
      store = this._createStore(agent, path.join(this._agentBinaryDir, agent))
      this._stores[agent] = store
      this._register(store)
      this._register(
        store.onDidChangeDownload((downloads) => this._forwardDownload(agent, downloads)),
      )
    }
    return store
  }

  private _buildStore(agent: AgentBinaryId, baseDir: string): AgentBinaryStore {
    if (agent === 'claude') {
      return new AgentBinaryStore({
        baseDir,
        flavor: createClaudeFlavor(() =>
          resolveVendorFile('claude-agent-acp', 'dist', 'claude-binary.json'),
        ),
        logger: this._loggerService,
      })
    }
    return new AgentBinaryStore({
      baseDir,
      flavor: codexFlavor,
      logger: this._loggerService,
    })
  }

  /**
   * The store fires per chunk, which is far too chatty for a tunnel. Intermediate
   * progress is throttled, but a state *transition* never is: a download appearing
   * or disappearing and the 100% frame always cross the wire, otherwise the panel
   * would sit on a download that already finished (or miss one that started).
   */
  private _forwardDownload(
    agent: AgentBinaryId,
    downloads: readonly AgentBinaryDownloadState[],
  ): void {
    const shape = downloads.map((d) => d.version).join('|')
    const complete = downloads.some((d) => d.total > 0 && d.received >= d.total)
    const transition = shape !== (this._lastShape.get(agent) ?? '') || complete
    const now = Date.now()
    const last = this._lastForward.get(agent)
    if (!transition && last !== undefined && now - last < PROGRESS_THROTTLE_MS) return
    this._lastShape.set(agent, shape)
    this._lastForward.set(agent, now)
    this._onDidChangeDownload.fire({ agent, downloads })
  }
}
