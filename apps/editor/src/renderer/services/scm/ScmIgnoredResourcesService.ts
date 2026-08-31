/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmIgnoredResourcesService — pull-style "is this path git-ignored?" cache.
 *
 *  The git status parser drops ignored entries, so the SCM decorations can't see
 *  them; instead we batch-resolve unknown paths through the owning provider's
 *  `<providerId>.checkIgnore` command (git check-ignore --stdin -z), mirroring
 *  VSCode's GitIgnoreDecorationProvider. Consumers (Explorer rows, editor tabs)
 *  call `isIgnored` during render: cached answers return synchronously, unknown
 *  paths are enqueued and return undefined, and a version observable bumps when
 *  the batch resolves so the next render picks up the cached answer.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  createDecorator,
  Disposable,
  ICommandService,
  IFileWatcherService,
  ILoggerService,
  IWorkspaceService,
  NullLogger,
  observableValue,
  URI,
  type IFileChangeEvent,
  type ILogger,
  type IObservable,
} from '@universe-editor/platform'
import { dirtyDiffCommandId } from '@universe-editor/extensions-common'
import { IScmService, resolveScmProviderId } from '../extensions/ScmService.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import { scmPathKey } from './ScmDecorationsService.js'
import { scmHostPath } from './scmHostPath.js'

/** Inline colour for ignored resources; the token is registered in universeColorIds. */
export const IGNORED_RESOURCE_FOREGROUND = 'var(--vscode-gitDecoration-ignoredResourceForeground)'

export interface IScmIgnoredResourcesService {
  readonly _serviceBrand: undefined
  /** Bumps whenever a batch resolves or the cache is invalidated, so consumers re-render. */
  readonly version: IObservable<number>
  /** Cached ignored status; undefined while unknown (the path is enqueued for a batch). */
  isIgnored(resource: URI): boolean | undefined
}

export const IScmIgnoredResourcesService = createDecorator<IScmIgnoredResourcesService>(
  'scmIgnoredResourcesService',
)

export class ScmIgnoredResourcesService extends Disposable implements IScmIgnoredResourcesService {
  declare readonly _serviceBrand: undefined

  readonly version: IObservable<number>

  private readonly _version = observableValue<number>('scmIgnoredResourcesVersion', 0)
  private readonly _cache = new Map<string, boolean>()
  private readonly _pending = new Map<string, string>()
  private _flushTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped on every invalidation so an in-flight flush can drop stale results. */
  private _generation = 0
  private readonly _logger: ILogger

  /** Debounce before a batch resolves; overridable in tests. */
  flushDelayMs = 150

  constructor(
    @IScmService private readonly _scm: IScmService,
    @ICommandService private readonly _commands: ICommandService,
    @IFileWatcherService watcher: IFileWatcherService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this.version = this._version
    this._logger =
      loggerService?.createLogger({ id: 'scmIgnoredResources', name: 'SCM Ignored Resources' }) ??
      new NullLogger()

    this._register(watcher.onDidChangeFiles((events) => this._onFileEvents(events)))
    this._register(this._workspace.onDidChangeWorkspace(() => this._invalidate()))

    let first = true
    this._register(
      autorun((reader) => {
        this._scm.sourceControls.read(reader)
        if (first) {
          first = false
          return
        }
        this._invalidate()
      }),
    )
  }

  override dispose(): void {
    if (this._flushTimer !== undefined) clearTimeout(this._flushTimer)
    super.dispose()
  }

  isIgnored(resource: URI): boolean | undefined {
    const fsPath = this._hostPath(resource)
    if (fsPath === undefined) return false
    const key = scmPathKey(fsPath)
    const cached = this._cache.get(key)
    if (cached !== undefined) return cached
    if (!this._pending.has(key)) this._pending.set(key, fsPath)
    this._scheduleFlush()
    return undefined
  }

  /** The path a resource has on the SCM host, or undefined when it is off-host. */
  private _hostPath(resource: URI): string | undefined {
    return scmHostPath(resource, currentRemoteAuthority(this._workspace.current))
  }

  private _onFileEvents(events: readonly IFileChangeEvent[]): void {
    for (const ev of events) {
      const fsPath = this._hostPath(ev.resource)
      if (fsPath === undefined) continue
      if (isGitIgnoreOrExclude(fsPath)) {
        this._invalidate()
        return
      }
    }
  }

  private _scheduleFlush(): void {
    if (this._flushTimer !== undefined) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = undefined
      void this._flush()
    }, this.flushDelayMs)
  }

  private async _flush(): Promise<void> {
    const entries = [...this._pending.entries()]
    this._pending.clear()
    if (entries.length === 0) return
    const generation = this._generation

    const byProvider = new Map<string, string[]>()
    for (const [key, fsPath] of entries) {
      const providerId = resolveScmProviderId(this._scm.sourceControls.get(), fsPath)
      if (providerId === undefined) {
        this._cache.set(key, false)
        continue
      }
      const list = byProvider.get(providerId)
      if (list) list.push(fsPath)
      else byProvider.set(providerId, [fsPath])
    }

    for (const [providerId, paths] of byProvider) {
      let ignored: readonly string[] | undefined
      try {
        ignored = await this._commands.executeCommand<readonly string[] | undefined>(
          dirtyDiffCommandId(providerId, 'checkIgnore'),
          paths,
        )
      } catch (err) {
        if (this._generation !== generation) return
        this._logger.warn(
          `check-ignore via ${providerId} failed; treating batch as not ignored`,
          err,
        )
        for (const p of paths) this._cache.set(scmPathKey(p), false)
        continue
      }
      // Invalidation fired while the command was in flight (e.g. a .gitignore save):
      // the cache/pending were cleared and the version bumped, so discard these
      // now-stale answers — the consumer's next render re-enqueues them.
      if (this._generation !== generation) return
      // undefined = command not registered (extension still activating / non-git
      // provider) — treat the batch as not ignored so we don't keep re-querying.
      if (ignored === undefined) {
        for (const p of paths) this._cache.set(scmPathKey(p), false)
        continue
      }
      const ignoredKeys = new Set(ignored.map((p) => scmPathKey(p)))
      for (const p of paths) this._cache.set(scmPathKey(p), ignoredKeys.has(scmPathKey(p)))
    }

    if (this._generation !== generation) return
    this._logger.debug(`resolved ${entries.length} ignored-resource query(s)`)
    this._version.set(this._version.get() + 1, undefined)
  }

  private _invalidate(): void {
    if (this._flushTimer !== undefined) {
      clearTimeout(this._flushTimer)
      this._flushTimer = undefined
    }
    this._generation++
    this._pending.clear()
    this._cache.clear()
    this._version.set(this._version.get() + 1, undefined)
  }
}

/** `.gitignore` files (any depth) and the repo-local `.git/info/exclude`. */
function isGitIgnoreOrExclude(fsPath: string): boolean {
  const p = fsPath.replace(/\\/g, '/')
  const name = p.slice(p.lastIndexOf('/') + 1)
  return name === '.gitignore' || p.endsWith('/.git/info/exclude')
}
