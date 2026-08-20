/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side facade between the Extensions UI and the two main-process
 *  services (gallery + management). The only mediator the UI depends on: it
 *  aggregates `ILocalExtension` (installed) and `IGalleryExtension` (marketplace)
 *  into one `IExtensionEntry` view model, tracks installing/searching state, and
 *  re-emits change events so React views refresh. Mirrors VSCode's
 *  `IExtensionsWorkbenchService`.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, Disposable, Emitter, type Event } from '@universe-editor/platform'
import {
  IDialogService,
  IHostService,
  INotificationService,
  IStorageService,
  IWorkspaceService,
  REMOTE_SCHEME,
  Severity,
  StorageScope,
  localize,
  remoteAuthorityLabel,
} from '@universe-editor/platform'
import {
  IExtensionManagementService,
  type ILocalExtension,
} from '../../../shared/ipc/extensionManagementService.js'
import {
  IExtensionGalleryService,
  type IGalleryExtension,
  type IQueryOptions,
} from '../../../shared/ipc/extensionGalleryService.js'
import { GallerySortBy, pickCompatibleVersion } from '@universe-editor/extension-gallery'
import {
  IExtensionEnablementService,
  EnablementState,
} from '../extensions/ExtensionEnablementService.js'
import { IExtensionHostClientService } from '../extensions/ExtensionHostClientService.js'

export { EnablementState }

/** Storage key (APPLICATION scope) for the remembered set of trusted publishers. */
const TRUSTED_PUBLISHERS_KEY = 'extensions.trustedPublishers'

/** Unified view model the Extensions UI renders. Aggregates installed + gallery. */
export interface IExtensionEntry {
  readonly id: string
  readonly displayName: string
  readonly publisher: string
  readonly publisherDisplayName?: string
  readonly description: string
  readonly version: string
  readonly installCount?: number
  readonly rating?: number
  /** Installed locally right now. */
  readonly installed: boolean
  /** A newer gallery version exists than the installed one. */
  readonly outdated: boolean
  /** An install/uninstall is in flight for this id. */
  readonly installing: boolean
  /** A bundled built-in extension (git / typescript / …); cannot be uninstalled. */
  readonly isBuiltin: boolean
  /**
   * Loaded from a --extension-development-path root. Shows a "development"
   * badge; uninstall/disable affordances are hidden (it is not in
   * `extensions.json`, so neither operation has meaning for it).
   */
  readonly isUnderDevelopment: boolean
  /** Whether the extension is currently enabled (resolved global + workspace). */
  readonly enabled: boolean
  /** The resolved enablement state (drives which enable/disable actions to show). */
  readonly enablementState: EnablementState
  /**
   * True when the extension's `engines.universe` is incompatible with the host
   * API version (auto-disabled at load; not a user-controlled disablement, so
   * enable/disable affordances are hidden).
   */
  readonly isVersionIncompatible: boolean
  /** Reason for `isVersionIncompatible`, e.g. `requires universe >=99.0.0, host is 0.13.0`. */
  readonly validationMessage?: string
  /**
   * True when no gallery version is compatible with the current host (marketplace
   * entries only) — the Install affordance is disabled.
   */
  readonly installIncompatible: boolean
  /**
   * The compatible version install will select, when it differs from the latest
   * `version` (marketplace entries only). Drives the "will install version X" note.
   */
  readonly installCompatibleVersion?: string
  /**
   * Runs on the remote host — the effective side of the current workspace: a
   * remote-installed user extension, or a built-in (same-source copy on the
   * remote). Absent for local-side entries and in a local workspace.
   */
  readonly remote?: boolean
  /**
   * A local-side user extension shown in a remote workspace: installed on this
   * machine but not on the remote, so it offers "Install in Remote".
   */
  readonly installableInRemote?: boolean
  /** Source references for actions (present when known). */
  readonly local?: ILocalExtension
  readonly gallery?: IGalleryExtension
  /** Set when the extension's `activate` threw in the host (drives the error badge). */
  readonly activationError?: IExtensionActivationError
}

/** A captured activation failure, shown as an error badge + detail on the row. */
export interface IExtensionActivationError {
  readonly message: string
  readonly stack?: string
}

export interface IExtensionsWorkbenchService {
  readonly _serviceBrand: undefined

  /** Fires whenever installed set, search results, or in-flight state changes. */
  readonly onDidChange: Event<void>

  /** Whether the marketplace is configured (drives search UI visibility). */
  isMarketplaceEnabled(): Promise<boolean>

  /** The installed extensions as entries (INSTALLED group). */
  getInstalled(): IExtensionEntry[]

  /** The last search's results as entries (MARKETPLACE group). Empty until a search. */
  getSearchResults(): IExtensionEntry[]

  /** The most recent search query text (empty = no active search). */
  readonly searchText: string

  /** True while a gallery query is in flight. */
  readonly searching: boolean

  /** Run a marketplace search (debounced by the caller). Empty text clears results. */
  search(text: string, options?: IQueryOptions): Promise<void>

  /**
   * Load the default "Market Extensions" listing (most-installed) with no search
   * term. Drives the always-on marketplace group. Network failure degrades to an
   * empty list (never throws).
   */
  loadFeatured(): Promise<void>

  /** Install a local `.vsix` by path (drag-and-drop onto the view). Refreshes. */
  installVSIX(vsixPath: string): Promise<void>

  /** Refresh the installed set from main (called on onDidChangeExtensions). */
  refreshInstalled(): Promise<void>

  /** Install a gallery extension; tracks installing state + refreshes. */
  install(entry: IExtensionEntry): Promise<void>

  /** Uninstall an installed extension; tracks installing state + refreshes. */
  uninstall(entry: IExtensionEntry): Promise<void>

  /** Enable / disable an extension at a given scope (global or workspace). */
  setEnablement(entry: IExtensionEntry, state: EnablementState): Promise<void>

  /** Whether a workspace is open (drives whether workspace-scope actions show). */
  hasWorkspace(): boolean

  /** The README text for an entry's detail page. */
  getReadme(entry: IExtensionEntry): Promise<string>

  /**
   * Icon as a `data:` URL for an entry (empty string if none). Marketplace icons
   * are remote https URLs the renderer CSP blocks, so main fetches + caches them.
   */
  getIcon(entry: IExtensionEntry): Promise<string>

  /** Find an entry by id across installed + search results (detail page lookup). */
  find(id: string): IExtensionEntry | undefined

  /** The current workspace folder's remote-ssh authority, or undefined when local. */
  readonly authority: string | undefined

  /**
   * Human label for the current remote authority ("WSL: ubuntu" / "SSH: host"),
   * or undefined when the workspace is local.
   */
  readonly remoteLabel: string | undefined

  /** Whether the marketplace currently has an entry for this local-side id (drives Install-in-Remote availability). */
  canInstallInRemote(id: string): Promise<boolean>

  /**
   * Install a local-side extension into the remote via the marketplace. Resolves
   * false when the marketplace has no entry for it (pure local VSIX / unreachable).
   */
  installInRemote(entry: IExtensionEntry): Promise<boolean>
}

export const IExtensionsWorkbenchService = createDecorator<IExtensionsWorkbenchService>(
  'extensionsWorkbenchService',
)

export class ExtensionsWorkbenchService extends Disposable implements IExtensionsWorkbenchService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  private _installed: ILocalExtension[] = []
  private _builtin: ILocalExtension[] = []
  private _dev: ILocalExtension[] = []
  /** Remote host's user extensions (empty for a local workspace). */
  private _remoteInstalled: ILocalExtension[] = []
  /** Current workspace folder's remote authority; undefined for a local workspace. */
  private _authority: string | undefined
  private _results: IGalleryExtension[] = []
  private _searchText = ''
  private _searching = false
  /** Editor app version (host API), fetched once from IHostService. */
  private _hostVersion: string | undefined
  /** ids with an install/uninstall in flight. */
  private readonly _installing = new Set<string>()
  /** Monotonic search token so a slow earlier query can't clobber a newer one. */
  private _searchSeq = 0
  /** Monotonic refresh token so a slow earlier authority's response can't clobber a newer one. */
  private _refreshSeq = 0
  /**
   * One marketplace lookup covering every local-side id that will offer
   * "Install in Remote" (rebuilt on each refresh; avoids a per-row N+1 query).
   */
  private _remoteGalleryPrefetch: Promise<Map<string, IGalleryExtension>> | undefined
  /** ids covered by the current prefetch; outside this set we fall back to a single lookup. */
  private _remoteGalleryPrefetchedIds = new Set<string>()
  /** Resolved enablement state per id, refreshed alongside the installed set. */
  private _enablementStates = new Map<string, EnablementState>()
  /** Activation failures keyed by extension id (cleared when the host relaunches). */
  private readonly _activationErrors = new Map<string, IExtensionActivationError>()

  constructor(
    @IExtensionManagementService private readonly _management: IExtensionManagementService,
    @IExtensionGalleryService private readonly _gallery: IExtensionGalleryService,
    @IDialogService private readonly _dialog: IDialogService,
    @IStorageService private readonly _storage: IStorageService,
    @INotificationService private readonly _notification: INotificationService,
    @IExtensionEnablementService private readonly _enablement: IExtensionEnablementService,
    @IExtensionHostClientService private readonly _hostClient: IExtensionHostClientService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IHostService private readonly _host: IHostService,
  ) {
    super()
    // Authority must follow the workspace (it hydrates async after startup) —
    // never a one-shot construction-time snapshot.
    this._authority = this._currentAuthority()
    this._register(
      this._workspace.onDidChangeWorkspace(() => {
        const next = this._currentAuthority()
        if (next === this._authority) return
        this._authority = next
        void this.refreshInstalled()
      }),
    )
    // Fetch the host API version once (async) so gallery entries can annotate
    // version compatibility; re-fire so views recompute once it lands.
    void this._host
      .getVersionInfo()
      .then((info) => {
        this._hostVersion = info.version
        this._onDidChange.fire()
      })
      .catch(() => {
        // host version unavailable — compatibility notes degrade to absent
      })
    this._register(this._management.onDidChangeExtensions(() => void this.refreshInstalled()))
    this._register(this._enablement.onDidChangeEnablement(() => void this.refreshInstalled()))
    this._register(
      this._hostClient.onDidActivationError((error) => {
        this._activationErrors.set(error.extensionId, {
          message: error.message,
          ...(error.stack !== undefined ? { stack: error.stack } : {}),
        })
        this._onDidChange.fire()
      }),
    )
    // A host relaunch (workspace swap / crash recovery / enable-disable) re-runs
    // activation from scratch, so stale failures shouldn't linger on the rows.
    this._register(this._hostClient.onDidChangeContributions(() => this._activationErrors.clear()))
  }

  get searchText(): string {
    return this._searchText
  }

  get searching(): boolean {
    return this._searching
  }

  get authority(): string | undefined {
    return this._authority
  }

  get remoteLabel(): string | undefined {
    return this._authority !== undefined ? remoteAuthorityLabel(this._authority) : undefined
  }

  isMarketplaceEnabled(): Promise<boolean> {
    return this._gallery.isEnabled()
  }

  hasWorkspace(): boolean {
    return this._enablement.hasWorkspace()
  }

  getInstalled(): IExtensionEntry[] {
    // Dev extensions first (the thing you're iterating on should be on top),
    // then built-ins, then remote-installed, then local user-installed. In a
    // remote workspace the effective side (built-ins + remote) precedes the
    // local side; a dev extension sharing an id with a built-in still shows
    // BOTH entries — the badge tells them apart, the host scan dedupe governs
    // which activates.
    const remote = this._authority !== undefined
    const entries: IExtensionEntry[] = []
    for (const local of this._dev) entries.push(this._entryFromLocal(local, false))
    for (const local of this._builtin) entries.push(this._entryFromLocal(local, remote))
    for (const local of this._remoteInstalled) entries.push(this._entryFromLocal(local, true))
    for (const local of this._installed) entries.push(this._entryFromLocal(local, false))
    return entries
  }

  getSearchResults(): IExtensionEntry[] {
    return this._results.map((gallery) => this._entryFromGallery(gallery))
  }

  async refreshInstalled(): Promise<void> {
    const seq = ++this._refreshSeq
    const authority = this._authority
    const [installed, builtin, dev, remoteInstalled] = await Promise.all([
      this._management.getInstalled(),
      this._management.listBuiltinExtensions(),
      this._management.listDevExtensions(),
      authority !== undefined
        ? this._management.getInstalled(authority).catch(() => this._remoteInstalled)
        : Promise.resolve([] as ILocalExtension[]),
    ])
    if (seq !== this._refreshSeq) return // a newer refresh superseded this one
    this._installed = installed
    this._builtin = builtin
    // Dev extensions are local-only paths the remote host never loads; showing
    // them in a remote workspace would claim an extension that isn't active.
    this._dev = authority !== undefined ? [] : dev
    this._remoteInstalled = remoteInstalled
    this._remoteGalleryPrefetch =
      authority !== undefined ? this._prefetchRemoteGallery(installed) : undefined
    // Resolve enablement for every id in one pass so entry mapping stays sync.
    const ids = [...builtin, ...remoteInstalled, ...installed].map((e) => e.identifier)
    const states = await Promise.all(ids.map((id) => this._enablement.getEnablementState(id)))
    if (seq !== this._refreshSeq) return
    this._enablementStates = new Map(ids.map((id, i) => [id, states[i]!]))
    this._onDidChange.fire()
  }

  async setEnablement(entry: IExtensionEntry, state: EnablementState): Promise<void> {
    await this._enablement.setEnablement(entry.id, state)
  }

  async search(text: string, options: IQueryOptions = {}): Promise<void> {
    const trimmed = text.trim()
    this._searchText = trimmed
    const seq = ++this._searchSeq

    if (!trimmed && !options.category) {
      this._results = []
      this._searching = false
      this._onDidChange.fire()
      return
    }

    this._searching = true
    this._onDidChange.fire()
    try {
      const result = await this._gallery.query({ text: trimmed, ...options })
      if (seq !== this._searchSeq) return // a newer search superseded this one
      this._results = [...result.extensions]
    } finally {
      if (seq === this._searchSeq) {
        this._searching = false
        this._onDidChange.fire()
      }
    }
  }

  async loadFeatured(): Promise<void> {
    this._searchText = ''
    const seq = ++this._searchSeq
    this._searching = true
    this._onDidChange.fire()
    try {
      const result = await this._gallery.query({ sortBy: GallerySortBy.InstallCount })
      if (seq !== this._searchSeq) return // a newer query superseded this one
      this._results = [...result.extensions]
    } finally {
      if (seq === this._searchSeq) {
        this._searching = false
        this._onDidChange.fire()
      }
    }
  }

  async installVSIX(vsixPath: string): Promise<void> {
    try {
      const local = await this._management.installVSIX(vsixPath, this._authority)
      this._notification.notify({
        severity: Severity.Info,
        message: localize('extensions.installVsix.done', 'Installed "{name}" ({version}).', {
          name: local.manifest.displayName ?? local.identifier,
          version: local.version,
        }),
      })
    } catch (err) {
      this._notification.notify({
        severity: Severity.Error,
        message: localize('extensions.installVsix.failed', 'Failed to install extension: {error}', {
          error: (err as Error).message,
        }),
      })
    }
    await this.refreshInstalled()
  }

  async install(entry: IExtensionEntry): Promise<void> {
    if (!entry.gallery) throw new Error(`no gallery entry for ${entry.id}`)
    if (!(await this._ensurePublisherTrusted(entry))) return

    this._installing.add(entry.id)
    this._onDidChange.fire()
    try {
      await this._management.installFromGallery(entry.gallery, this._authority)
    } catch (err) {
      this._notification.notify({
        severity: Severity.Error,
        message: localize('extensions.install.failed', 'Failed to install {name}: {error}', {
          name: entry.displayName,
          error: (err as Error).message,
        }),
      })
    } finally {
      this._installing.delete(entry.id)
    }
    await this.refreshInstalled()
  }

  /**
   * First install from a publisher prompts a plain-language trust dialog (the
   * extension runs with near-native capabilities — see the honest-boundary note).
   * A remembered publisher installs silently thereafter. Returns false if the
   * user declined.
   */
  private async _ensurePublisherTrusted(entry: IExtensionEntry): Promise<boolean> {
    const publisher = entry.publisher
    if (!publisher || (await this._isPublisherTrusted(publisher))) return true

    const result = await this._dialog.confirm({
      type: 'warning',
      message: localize('extensions.trust.message', 'Install "{name}" from {publisher}?', {
        name: entry.displayName,
        publisher: entry.publisherDisplayName ?? publisher,
      }),
      detail: localize(
        'extensions.trust.detail',
        'This extension runs with near-native access to your files and network. Only install extensions from publishers you trust.',
      ),
      primaryButton: localize('extensions.trust.confirm', 'Trust Publisher & Install'),
      cancelButton: localize('common.cancel', 'Cancel'),
    })
    if (!result.confirmed) return false

    await this._trustPublisher(publisher)
    return true
  }

  private async _trustedPublishers(): Promise<string[]> {
    const stored = await this._storage.get<string[]>(TRUSTED_PUBLISHERS_KEY, StorageScope.GLOBAL)
    return Array.isArray(stored) ? stored : []
  }

  private async _isPublisherTrusted(publisher: string): Promise<boolean> {
    return (await this._trustedPublishers()).includes(publisher)
  }

  private async _trustPublisher(publisher: string): Promise<void> {
    const next = [...new Set([...(await this._trustedPublishers()), publisher])]
    await this._storage.set(TRUSTED_PUBLISHERS_KEY, next, StorageScope.GLOBAL)
  }

  async uninstall(entry: IExtensionEntry): Promise<void> {
    this._installing.add(entry.id)
    this._onDidChange.fire()
    try {
      // Route by the entry's side: remote-side entries uninstall from the remote
      // host, local-side entries from this machine.
      await this._management.uninstall(entry.id, this._authorityFor(entry))
    } finally {
      this._installing.delete(entry.id)
    }
    await this.refreshInstalled()
  }

  getReadme(entry: IExtensionEntry): Promise<string> {
    if (entry.gallery) return this._gallery.getReadme(entry.gallery)
    return Promise.resolve(entry.local?.manifest.description ?? '')
  }

  getIcon(entry: IExtensionEntry): Promise<string> {
    if (entry.gallery) return this._gallery.getIcon(entry.gallery)
    // Installed / built-in: read the extension's own manifest icon. Remote-side
    // entries resolve through the remote host (their `location` is ''); built-ins
    // stay local — the same-source copy on this machine has the same icon.
    if (entry.installed) {
      return this._management.getLocalIcon(entry.id, this._authorityFor(entry))
    }
    return Promise.resolve('')
  }

  find(id: string): IExtensionEntry | undefined {
    return (
      this.getInstalled().find((e) => e.id === id) ??
      this.getSearchResults().find((e) => e.id === id)
    )
  }

  async canInstallInRemote(id: string): Promise<boolean> {
    return (await this._resolveRemoteGallery(id)) !== undefined
  }

  async installInRemote(entry: IExtensionEntry): Promise<boolean> {
    const gallery = await this._resolveRemoteGallery(entry.id)
    if (!gallery) return false
    if (!(await this._ensurePublisherTrusted(entry))) return false

    this._installing.add(entry.id)
    this._onDidChange.fire()
    try {
      await this._management.installFromGallery(gallery, this._authority)
    } catch (err) {
      this._notification.notify({
        severity: Severity.Error,
        message: localize(
          'extensions.installInRemote.failed',
          'Failed to install {name} on {label}: {error}',
          {
            name: entry.displayName,
            label: this.remoteLabel ?? this._authority ?? '',
            error: (err as Error).message,
          },
        ),
      })
      return false
    } finally {
      this._installing.delete(entry.id)
      await this.refreshInstalled()
    }
    return true
  }

  /** Look up a local-side id in the marketplace (empty when unreachable / pure local VSIX). */
  private async _resolveRemoteGallery(id: string): Promise<IGalleryExtension | undefined> {
    if (this._remoteGalleryPrefetch !== undefined && this._remoteGalleryPrefetchedIds.has(id)) {
      return (await this._remoteGalleryPrefetch).get(id)
    }
    try {
      const [found] = await this._gallery.getExtensions([id])
      return found
    } catch {
      return undefined
    }
  }

  /** Prefetch the marketplace entries for every local-side id that will offer "Install in Remote". */
  private _prefetchRemoteGallery(
    installed: ILocalExtension[],
  ): Promise<Map<string, IGalleryExtension>> {
    const ids = installed
      .filter((e) => e.source !== 'builtin' && e.source !== 'development')
      .map((e) => e.identifier)
    this._remoteGalleryPrefetchedIds = new Set(ids)
    if (ids.length === 0) return Promise.resolve(new Map())
    return this._gallery
      .getExtensions(ids)
      .then((exts) => new Map(exts.map((e) => [e.identifier, e])))
      .catch(() => new Map())
  }

  /** Resolved enablement state for an id (defaults to EnabledGlobally if unknown). */
  private _stateOf(id: string): EnablementState {
    return this._enablementStates.get(id) ?? EnablementState.EnabledGlobally
  }

  /** The current workspace folder's remote authority, or undefined for a local folder. */
  private _currentAuthority(): string | undefined {
    const folder = this._workspace.current?.folder
    return folder !== undefined && folder.scheme === REMOTE_SCHEME ? folder.authority : undefined
  }

  /**
   * The authority to route a management/icon call through: remote-side entries
   * resolve remotely, but built-ins (same source on both machines) stay local.
   */
  private _authorityFor(entry: IExtensionEntry): string | undefined {
    return entry.remote && !entry.isBuiltin ? this._authority : undefined
  }

  private _isEnabledState(state: EnablementState): boolean {
    return state === EnablementState.EnabledGlobally || state === EnablementState.EnabledWorkspace
  }

  /** The installed set the current workspace actually runs (remote or local user extensions). */
  private _effectiveInstalled(): ILocalExtension[] {
    return this._authority !== undefined ? this._remoteInstalled : this._installed
  }

  private _entryFromLocal(local: ILocalExtension, remote: boolean): IExtensionEntry {
    const m = local.manifest
    const state = this._stateOf(local.identifier)
    const activationError = this._activationErrors.get(local.identifier)
    const isBuiltin = local.source === 'builtin'
    const isDev = local.source === 'development'
    return {
      id: local.identifier,
      displayName: m.displayName ?? m.name,
      publisher: m.publisher ?? '',
      description: m.description ?? '',
      version: local.version,
      installed: true,
      outdated: false,
      installing: this._installing.has(local.identifier),
      isBuiltin,
      isUnderDevelopment: isDev,
      enabled: this._isEnabledState(state),
      enablementState: state,
      isVersionIncompatible: local.isVersionCompatible === false,
      installIncompatible: false,
      ...(local.validationMessage !== undefined
        ? { validationMessage: local.validationMessage }
        : {}),
      local,
      ...(remote ? { remote: true } : {}),
      ...(this._authority !== undefined && !remote && !isBuiltin && !isDev
        ? { installableInRemote: true }
        : {}),
      ...(activationError ? { activationError } : {}),
      ...(local.galleryMetadata?.publisherDisplayName
        ? { publisherDisplayName: local.galleryMetadata.publisherDisplayName }
        : {}),
      ...(local.galleryMetadata?.installCount !== undefined
        ? { installCount: local.galleryMetadata.installCount }
        : {}),
    }
  }

  private _entryFromGallery(gallery: IGalleryExtension): IExtensionEntry {
    const local = this._effectiveInstalled().find((l) => l.identifier === gallery.identifier)
    const state = this._stateOf(gallery.identifier)
    const picked =
      this._hostVersion !== undefined
        ? pickCompatibleVersion(gallery, this._hostVersion)
        : undefined
    const installIncompatible = this._hostVersion !== undefined && picked === undefined
    const installCompatibleVersion =
      picked !== undefined && picked.version !== gallery.version ? picked.version : undefined
    return {
      id: gallery.identifier,
      displayName: gallery.displayName,
      publisher: gallery.publisher,
      description: gallery.description,
      version: gallery.version,
      installed: local !== undefined,
      outdated: local !== undefined && local.version !== gallery.version,
      installing: this._installing.has(gallery.identifier),
      isBuiltin: false,
      isUnderDevelopment: false,
      enabled: local === undefined || this._isEnabledState(state),
      enablementState: state,
      isVersionIncompatible: false,
      installIncompatible,
      ...(installCompatibleVersion !== undefined ? { installCompatibleVersion } : {}),
      gallery,
      ...(local ? { local, ...(this._authority !== undefined ? { remote: true } : {}) } : {}),
      ...(gallery.publisherDisplayName
        ? { publisherDisplayName: gallery.publisherDisplayName }
        : {}),
      ...(gallery.installCount !== undefined ? { installCount: gallery.installCount } : {}),
      ...(gallery.rating !== undefined ? { rating: gallery.rating } : {}),
    }
  }
}
