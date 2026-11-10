/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  One-shot `git status` probes for mobile workspace candidates. Local workspaces only:
 *  remote windows report through their renderer's SCM model instead.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process'
import { buildChildEnv } from '@universe-editor/node-services'
import {
  Disposable,
  getPathComparisonKey,
  isAbsolutePath,
  normalizePlatform,
  type HostPlatform,
  type ILogger,
} from '@universe-editor/platform'

export const WORKSPACE_GIT_STATUS_TIMEOUT_MS = 1500
export const WORKSPACE_GIT_STATUS_CACHE_TTL_MS = 5000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export interface GitStatusRunOptions {
  readonly root: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/** Resolves stdout; any failure (non-repo, missing git, timeout) must reject. */
export type GitStatusRunner = (options: GitStatusRunOptions) => Promise<string>

export interface WorkspaceGitStatusServiceOptions {
  readonly runner?: GitStatusRunner
  readonly now?: () => number
  readonly platform?: HostPlatform
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly logger?: ILogger
}

interface CacheEntry {
  readonly value: boolean | undefined
  readonly expiresAt: number
}

function createDefaultGitStatusRunner(): GitStatusRunner {
  return ({ root, timeoutMs, signal }) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['status', '--porcelain', '-z'],
        {
          cwd: root,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          env: buildChildEnv(process.env, { overrides: { GIT_OPTIONAL_LOCKS: '0' } }),
          signal,
        },
        (error, stdout) => {
          if (error !== null) reject(error)
          else resolve(stdout)
        },
      )
    })
}

/**
 * Answers "does this local workspace have uncommitted changes?" with a small
 * TTL cache. Unknown results (non-repo, git unavailable, timeout) are cached
 * too so a list of non-git recent folders does not spawn git on every page
 * open; aborted probes are never cached.
 */
export class WorkspaceGitStatusService extends Disposable {
  private readonly _runner: GitStatusRunner
  private readonly _now: () => number
  private readonly _platform: HostPlatform
  private readonly _ttlMs: number
  private readonly _timeoutMs: number
  private readonly _logger: ILogger | undefined
  private readonly _cache = new Map<string, CacheEntry>()
  private readonly _inflight = new Map<string, Promise<boolean | undefined>>()
  private readonly _controllers = new Set<AbortController>()
  private _disposed = false

  constructor(options: WorkspaceGitStatusServiceOptions = {}) {
    super()
    this._runner = options.runner ?? createDefaultGitStatusRunner()
    this._now = options.now ?? (() => Date.now())
    this._platform = options.platform ?? normalizePlatform(process.platform)
    this._ttlMs = options.ttlMs ?? WORKSPACE_GIT_STATUS_CACHE_TTL_MS
    this._timeoutMs = options.timeoutMs ?? WORKSPACE_GIT_STATUS_TIMEOUT_MS
    this._logger = options.logger
  }

  /** `true`/`false` when known; `undefined` for non-repo, missing git or timeout. */
  async isDirty(root: string, signal?: AbortSignal): Promise<boolean | undefined> {
    if (this._disposed || !isAbsolutePath(root, this._platform)) return undefined
    const key = getPathComparisonKey(root, this._platform)
    const cached = this._cache.get(key)
    if (cached !== undefined) {
      if (cached.expiresAt > this._now()) return cached.value
      this._cache.delete(key)
    }
    const probe = this._inflight.get(key) ?? this._startProbe(key, root)
    // The caller's abort only stops this waiter; the shared probe keeps
    // running under its own timeout so other callers and the cache are not
    // poisoned by one caller's budget.
    if (signal === undefined) return probe
    return raceWithAbort(probe, signal)
  }

  override dispose(): void {
    if (this._disposed) return
    this._disposed = true
    for (const controller of this._controllers) controller.abort()
    this._controllers.clear()
    this._inflight.clear()
    this._cache.clear()
    super.dispose()
  }

  private _startProbe(key: string, root: string): Promise<boolean | undefined> {
    const controller = new AbortController()
    this._controllers.add(controller)
    const probe = this._executeProbe(key, root, controller)
    this._inflight.set(key, probe)
    void probe.finally(() => {
      if (this._inflight.get(key) === probe) this._inflight.delete(key)
    })
    return probe
  }

  private async _executeProbe(
    key: string,
    root: string,
    controller: AbortController,
  ): Promise<boolean | undefined> {
    try {
      const stdout = await this._runner({
        root,
        timeoutMs: this._timeoutMs,
        signal: controller.signal,
      })
      const value = stdout.length > 0
      this._cache.set(key, { value, expiresAt: this._now() + this._ttlMs })
      return value
    } catch (error) {
      if (!controller.signal.aborted) {
        this._logger?.debug(`git status failed for ${root}: ${String(error)}`)
        this._cache.set(key, { value: undefined, expiresAt: this._now() + this._ttlMs })
      }
      return undefined
    } finally {
      this._controllers.delete(controller)
    }
  }
}

function raceWithAbort(
  probe: Promise<boolean | undefined>,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<boolean | undefined>((resolve) => {
    let settled = false
    const finish = (value: boolean | undefined): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    void probe.then(finish, () => finish(undefined))
  })
}
