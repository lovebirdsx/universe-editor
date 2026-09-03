/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSubProjectService — resolves the set of "sub-project roots" an agent
 *  session may target, layered above the workspace root:
 *
 *    1. the workspace folder itself (source 'workspace', label 'Workspace'),
 *    2. every directory listed in `acp.projectRoots` (source 'configured'),
 *    3. the project root detected from the active editor's file by walking up
 *       for `acp.subProject.detectMarkers` (source 'detected').
 *
 *  Consumers (session pickers, the "new session" cwd resolver) read `getScopes()`;
 *  `detectForResource` answers the narrower "which project does this file belong
 *  to" question and caches its IO-heavy answer per resource.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  createDecorator,
  fsPathToWorkspaceUri,
  IConfigurationService,
  IEditorService,
  IFileService,
  ILoggerService,
  InstantiationType,
  isAbsolutePath,
  IUriIdentityService,
  IWorkspaceService,
  localize,
  registerSingleton,
  URI,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import { getOriginalResource } from '../../editor/editorResourceAccessor.js'

export interface SubProjectScope {
  readonly cwd: string
  readonly authority?: string
  readonly source: 'workspace' | 'configured' | 'detected'
  readonly label: string // 相对工作区根的路径，例如 "packages/client/src/app"；根目录为本地化的「工作区」
}

export interface ISubProjectService {
  readonly _serviceBrand: undefined
  getScopes(): Promise<SubProjectScope[]>
  /**
   * The workspace root plus every resolvable `acp.projectRoots` entry — the
   * IO-free subset of `getScopes()`. The restore coordinator uses this instead:
   * a `detected` root is an affordance for *creating* a session, so hydrating it
   * would spawn an agent against a directory that has no session history (one
   * that does is derived from history instead), and paying for the upward marker
   * walk just to filter the result out is pure waste on every sweep.
   */
  getConfiguredScopes(): SubProjectScope[]
  detectForResource(resource: URI): Promise<SubProjectScope | undefined>
  detectActiveProject(): Promise<SubProjectScope | undefined>
  readonly onDidChange: Event<void>
}

export const ISubProjectService = createDecorator<ISubProjectService>('acpSubProjectService')

export const PROJECT_ROOTS_KEY = 'acp.projectRoots'
const DETECT_ENABLED_KEY = 'acp.subProject.detectEnabled'
const DETECT_MARKERS_KEY = 'acp.subProject.detectMarkers'
const MAX_DEPTH_KEY = 'acp.subProject.maxDepth'

const DEFAULT_MARKERS = [
  '.git',
  'package.json',
  'tsconfig.json',
  'p4config',
  'p4config.txt',
  '.p4ignore',
  'Cargo.toml',
  'go.mod',
  'CMakeLists.txt',
  'pyproject.toml',
] as const

const DEFAULT_MAX_DEPTH = 20

type DetectResult = { readonly uri: URI; readonly source: 'configured' | 'detected' } | undefined

export class AcpSubProjectService extends Disposable implements ISubProjectService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  private readonly _logger: ILogger
  private readonly _detectCache = new Map<string, Promise<DetectResult>>()

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileService private readonly _fileService: IFileService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IEditorService private readonly _editor: IEditorService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'acpSubProject', name: 'ACP Sub-project' })
    this._register(this._workspace.onDidChangeWorkspace(() => this._invalidate('workspace')))
    this._register(
      this._config.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(PROJECT_ROOTS_KEY) ||
          e.affectsConfiguration(DETECT_ENABLED_KEY) ||
          e.affectsConfiguration(DETECT_MARKERS_KEY) ||
          e.affectsConfiguration(MAX_DEPTH_KEY)
        ) {
          this._invalidate('config')
        }
      }),
    )
  }

  getConfiguredScopes(): SubProjectScope[] {
    return this._configuredScopeList().scopes
  }

  async getScopes(): Promise<SubProjectScope[]> {
    const { scopes, seen } = this._configuredScopeList()
    const active = getOriginalResource(this._editor.activeEditor.get())
    if (!active) return scopes

    const detected = await this._cachedDetect(active)
    if (detected && detected.source === 'detected') {
      const key = this._uriIdentity.getComparisonKey(detected.uri)
      if (!seen.has(key)) scopes.push(this._scopeFor(detected.uri, 'detected'))
    }
    return scopes
  }

  async detectForResource(resource: URI): Promise<SubProjectScope | undefined> {
    const result = await this._cachedDetect(resource)
    return result ? this._scopeFor(result.uri, result.source) : undefined
  }

  async detectActiveProject(): Promise<SubProjectScope | undefined> {
    const resource = getOriginalResource(this._editor.activeEditor.get())
    if (!resource) return undefined
    return this.detectForResource(resource)
  }

  // -- internals ---------------------------------------------------------

  /** Root + configured roots, with the comparison-key set so `getScopes()` can
   *  keep deduplicating the detected root against them. A single unresolvable
   *  `acp.projectRoots` entry is skipped rather than failing the whole list. */
  private _configuredScopeList(): { scopes: SubProjectScope[]; seen: Set<string> } {
    const scopes: SubProjectScope[] = []
    const seen = new Set<string>()
    const push = (uri: URI, source: SubProjectScope['source']): void => {
      const key = this._uriIdentity.getComparisonKey(uri)
      if (seen.has(key)) return
      seen.add(key)
      scopes.push(this._scopeFor(uri, source))
    }

    const root = this._workspace.current?.folder
    if (root) push(root, 'workspace')
    for (const entry of this._configuredRoots()) {
      try {
        const uri = this._resolveConfiguredRoot(entry)
        if (uri) push(uri, 'configured')
      } catch (err) {
        this._logger.warn(`ignoring unresolvable ${PROJECT_ROOTS_KEY} entry "${entry}": ${err}`)
      }
    }
    return { scopes, seen }
  }

  private _invalidate(reason: 'workspace' | 'config'): void {
    this._detectCache.clear()
    this._logger.debug(`sub-project scopes invalidated (${reason})`)
    this._onDidChange.fire()
  }

  private _cachedDetect(resource: URI): Promise<DetectResult> {
    const key = this._uriIdentity.getComparisonKey(resource)
    const cached = this._detectCache.get(key)
    if (cached) return cached
    // Evict on rejection: caching a rejected promise would poison this resource
    // until the next workspace/config change, permanently breaking `getScopes()`
    // (and with it the scope picker) over one transient provider error.
    const pending = this._detectRaw(resource).catch((err: unknown) => {
      this._detectCache.delete(key)
      throw err
    })
    this._detectCache.set(key, pending)
    return pending
  }

  private async _detectRaw(resource: URI): Promise<DetectResult> {
    const root = this._workspace.current?.folder
    if (!root) {
      this._logger.debug(`detect: ${resource.toString()} — no workspace`)
      return undefined
    }
    if (!this._uriIdentity.isEqualOrParent(resource, root)) {
      this._logger.debug(`detect: ${resource.toString()} — outside workspace`)
      return undefined
    }

    const configured = this._matchConfiguredRoot(resource)
    if (configured) {
      this._logger.debug(`detect: ${resource.toString()} → configured ${configured.fsPath}`)
      return { uri: configured, source: 'configured' }
    }

    if (!this._detectEnabled()) return undefined
    const markers = this._detectMarkers()
    if (markers.length === 0) return undefined
    const maxDepth = this._maxDepth()

    let current = await this._startDir(resource)
    for (let depth = 0; current && depth < maxDepth; depth++) {
      if (await this._hasMarker(current, markers)) {
        this._logger.debug(`detect: ${resource.toString()} → detected ${current.fsPath}`)
        return { uri: current, source: 'detected' }
      }
      if (this._uriIdentity.isEqual(current, root)) break
      current = URI.joinPath(current, '..')
    }
    this._logger.debug(`detect: ${resource.toString()} → no marker within ${maxDepth} levels`)
    return undefined
  }

  private async _startDir(resource: URI): Promise<URI> {
    try {
      const stat = await this._fileService.stat(resource)
      if (stat.isDirectory) return resource
    } catch {
      // Non-existent or unstat-able → treat as a file and start from its parent.
    }
    return URI.joinPath(resource, '..')
  }

  private async _hasMarker(dir: URI, markers: readonly string[]): Promise<boolean> {
    for (const marker of markers) {
      try {
        if (await this._fileService.exists(URI.joinPath(dir, marker))) return true
      } catch {
        // A provider error on one candidate is not a hit — keep probing.
      }
    }
    return false
  }

  private _matchConfiguredRoot(resource: URI): URI | undefined {
    let best: URI | undefined
    let bestDepth = -1
    for (const entry of this._configuredRoots()) {
      let cfg: URI | undefined
      try {
        cfg = this._resolveConfiguredRoot(entry)
      } catch {
        continue // reported by _configuredScopeList; one bad entry is not a miss
      }
      if (!cfg) continue
      if (!this._uriIdentity.isEqualOrParent(resource, cfg)) continue
      if (cfg.path.length > bestDepth) {
        best = cfg
        bestDepth = cfg.path.length
      }
    }
    return best
  }

  private _resolveConfiguredRoot(entry: string): URI | undefined {
    const root = this._workspace.current?.folder
    if (!root) return undefined
    if (isAbsolutePath(entry, this._uriIdentity.platform)) {
      return fsPathToWorkspaceUri(entry, root.authority || undefined)
    }
    const segments = entry.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.')
    return URI.joinPath(root, ...segments)
  }

  private _scopeFor(uri: URI, source: SubProjectScope['source']): SubProjectScope {
    const root = this._workspace.current?.folder
    const label = root ? this._labelFor(uri, root) : uri.path
    const authority = uri.authority || undefined
    return {
      cwd: uri.fsPath,
      ...(authority ? { authority } : {}),
      source,
      label,
    }
  }

  private _labelFor(uri: URI, root: URI): string {
    if (this._uriIdentity.isEqual(uri, root)) {
      return localize('agent.scope.workspace', 'Workspace')
    }
    return this._uriIdentity.relativePath(root, uri) ?? uri.path
  }

  private _configuredRoots(): readonly string[] {
    const raw = this._config.get<unknown>(PROJECT_ROOTS_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
  }

  private _detectEnabled(): boolean {
    return this._config.get<boolean>(DETECT_ENABLED_KEY) !== false
  }

  private _detectMarkers(): readonly string[] {
    const raw = this._config.get<unknown>(DETECT_MARKERS_KEY)
    if (!Array.isArray(raw)) return DEFAULT_MARKERS
    const markers = raw.filter((e): e is string => typeof e === 'string' && e.length > 0)
    return markers.length > 0 ? markers : DEFAULT_MARKERS
  }

  private _maxDepth(): number {
    const raw = this._config.get<number>(MAX_DEPTH_KEY)
    const value =
      typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_MAX_DEPTH
    return Math.max(1, Math.min(100, value))
  }
}

registerSingleton(ISubProjectService, AcpSubProjectService, InstantiationType.Delayed)
