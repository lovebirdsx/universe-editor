/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side facade between the Extensions UI and the two main-process
 *  services (gallery + management). The only mediator the UI depends on: it
 *  aggregates `ILocalExtension` (installed) and `IGalleryExtension` (marketplace)
 *  into one `IExtensionEntry` view model, tracks installing/searching state, and
 *  re-emits change events so React views refresh. Also owns the pending-update
 *  state: what the marketplace offers, what the badge/strip/toasts say about it,
 *  and the per-extension auto-update opt-out. Mirrors VSCode's
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
  type IPromptChoice,
} from '@universe-editor/platform'
import {
  IExtensionManagementService,
  type ILocalExtension,
  type IExtensionUpdate,
  type IExtensionUpdateCheckResult,
  type IExtensionUpdateOutcome,
} from '../../../shared/ipc/extensionManagementService.js'
import {
  IExtensionGalleryService,
  type IGalleryExtension,
  type IQueryOptions,
} from '../../../shared/ipc/extensionGalleryService.js'
import { GallerySortBy, pickCompatibleVersion } from '@universe-editor/extension-gallery'
import { compareVersions } from '@universe-editor/extensions-common'
import {
  IExtensionEnablementService,
  EnablementState,
} from '../extensions/ExtensionEnablementService.js'
import { IExtensionHostClientService } from '../extensions/ExtensionHostClientService.js'
import { updateSetSignature } from '../extensionsUpdates/extensionUpdatePolicy.js'

export { EnablementState }

/** Storage key (APPLICATION scope) for the remembered set of trusted publishers. */
const TRUSTED_PUBLISHERS_KEY = 'extensions.trustedPublishers'

/** Storage key (GLOBAL scope, like trustedPublishers) for ids the user opted out of auto-update. */
const AUTO_UPDATE_OPT_OUT_KEY = 'extensions.autoUpdateDisabled'

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
  /** The newer version the marketplace offers, when the last check found one. */
  readonly updateVersion?: string
  /** False when the user opted this extension out of automatic updates. Absent = on. */
  readonly autoUpdate?: boolean
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

/** Outcome of applying one or more pending updates. */
export interface IExtensionsUpdateRunResult {
  readonly updated: readonly string[]
  readonly failed: readonly { readonly identifier: string; readonly error: string }[]
  /**
   * Pending updates the run left alone — the publisher's trust was declined, or a
   * silent (automatic) run found it untrusted. They stay pending, not failed.
   */
  readonly skipped: readonly string[]
}

export type ExtensionsNotificationKind = 'updates' | 'up-to-date' | 'failed'

/**
 * The Extensions view's in-view notification strip. `kind` exists so callers (and
 * e2e probes) can branch on state without matching a localized string.
 */
export interface IExtensionsNotification {
  readonly kind: ExtensionsNotificationKind
  readonly severity: Severity
  readonly message: string
  readonly actions: readonly IPromptChoice[]
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

  /** Pending updates by identifier, as of the last check (empty before any check). */
  getPendingUpdates(): readonly IExtensionUpdate[]

  /**
   * Refresh pending updates from the marketplace. `explicit` marks a user-initiated
   * check, whose outcome is announced even when there is nothing to report.
   */
  checkForUpdates(options?: { explicit?: boolean }): Promise<readonly IExtensionUpdate[]>

  /**
   * Apply one pending update through the same gates as `install()`. `silent` skips
   * the publisher-trust prompt instead of answering it — an untrusted publisher's
   * update is refused, not installed.
   */
  update(id: string, options?: { silent?: boolean }): Promise<boolean>

  /**
   * Apply several pending updates as one batch (one extension-host restart). With
   * no `ids`, applies every pending update. At most one Info + one Error toast.
   */
  updateAll(
    ids?: readonly string[],
    options?: { silent?: boolean },
  ): Promise<IExtensionsUpdateRunResult>

  /** The strip to show above the list, or undefined when there is nothing to say. */
  getExtensionsNotification(): IExtensionsNotification | undefined

  /** Hide the current strip until the pending set or the check outcome changes. */
  dismissExtensionsNotification(): void

  /** Opt one identifier in or out of automatic updates (persisted per machine). */
  setAutoUpdateEnabled(id: string, enabled: boolean): Promise<void>
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
  /** Pending updates for the side the last check covered; replaced, never mutated. */
  private _pending = new Map<string, IExtensionUpdate>()
  /** Authority the pending set was computed for (undefined = this machine's user extensions). */
  private _pendingAuthority: string | undefined
  /** Transient outcome of the most recent check; drives the strip's non-update variants. */
  private _checkOutcome: { kind: 'up-to-date' | 'failed'; message?: string } | undefined
  /** Strip signature the user dismissed, so a dismissal survives unrelated re-renders. */
  private _dismissedSignature: string | undefined
  /** Signature last announced by a background check (the anti-spam gate). */
  private _notifiedSignature: string | undefined
  /** Identifiers the user opted out of automatic updates (GLOBAL storage). */
  private readonly _autoUpdateOptOut = new Set<string>()

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
        // The pending set describes the host we just left. Keeping it would offer
        // updates for extensions this window can no longer see or install.
        this._pending = new Map()
        this._pendingAuthority = undefined
        this._checkOutcome = undefined
        this._dismissedSignature = undefined
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
    void this._loadAutoUpdateOptOut()
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
    this._prunePendingUpdates()
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
    // Hide the row now: the authoritative re-read round-trips the extension host,
    // and until then the row would sit there still offering Uninstall.
    const restore = this._hideInstalled(entry.id, this._authorityFor(entry) !== undefined)
    this._onDidChange.fire()
    try {
      // Route by the entry's side: remote-side entries uninstall from the remote
      // host, local-side entries from this machine.
      await this._management.uninstall(entry.id, this._authorityFor(entry))
    } catch (err) {
      restore()
      this._notification.notify({
        severity: Severity.Error,
        message: localize('extensions.uninstall.failed', 'Failed to uninstall {name}: {error}', {
          name: entry.displayName,
          error: (err as Error).message,
        }),
      })
      return
    } finally {
      this._installing.delete(entry.id)
      this._onDidChange.fire()
    }
    await this.refreshInstalled()
  }

  /**
   * Drop an id from the installed snapshot while its uninstall is in flight,
   * returning a closure that puts it back. Only the side being uninstalled is
   * touched — the same extension can be installed locally and remotely at once.
   */
  private _hideInstalled(id: string, remote: boolean): () => void {
    const source = this._installedList(remote)
    const index = source.findIndex((local) => local.identifier === id)
    const hidden = source[index]
    if (hidden === undefined) return () => undefined
    this._setInstalledList(
      remote,
      source.filter((_, i) => i !== index),
    )
    return () => {
      const current = this._installedList(remote)
      // A refresh that landed while the uninstall was in flight may have read the
      // extension back already; inserting another copy would list it twice.
      if (current.some((local) => local.identifier === id)) return
      this._setInstalledList(remote, [...current.slice(0, index), hidden, ...current.slice(index)])
    }
  }

  private _installedList(remote: boolean): ILocalExtension[] {
    return remote ? this._remoteInstalled : this._installed
  }

  private _setInstalledList(remote: boolean, next: ILocalExtension[]): void {
    if (remote) this._remoteInstalled = next
    else this._installed = next
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

  getPendingUpdates(): readonly IExtensionUpdate[] {
    if (!this._pendingBelongsToCurrentWorkspace()) return []
    return [...this._pending.values()]
  }

  async checkForUpdates(
    options: { explicit?: boolean } = {},
  ): Promise<readonly IExtensionUpdate[]> {
    const explicit = options.explicit === true
    const authority = this._authority
    if (!(await this._gallery.isEnabled())) {
      if (explicit) {
        this._notification.notify({
          severity: Severity.Warning,
          message: localize(
            'extensions.check.noMarketplace',
            'The extension marketplace is not configured, so updates cannot be checked.',
          ),
        })
      }
      return []
    }

    let result: IExtensionUpdateCheckResult
    try {
      result = await this._management.checkForUpdates(authority)
    } catch (err) {
      result = { updates: [], failure: (err as Error).message }
    }
    // Guard the whole state mutation, failure included: the workspace may have
    // switched mid-flight, and that refresh owns the state now.
    if (authority !== this._authority) return result.updates

    this._pending = new Map(result.updates.map((update) => [update.identifier, update]))
    this._pendingAuthority = authority
    // An explicit check answers the question the user just asked, so it brings the
    // strip back; a background check leaves a dismissal alone (the signature
    // re-shows it on its own once the set or the outcome actually changes).
    if (explicit) this._dismissedSignature = undefined
    this._checkOutcome =
      result.failure !== undefined
        ? { kind: 'failed', message: result.failure }
        : result.updates.length === 0
          ? { kind: 'up-to-date' }
          : undefined
    this._onDidChange.fire()

    if (explicit) this._notifyExplicitOutcome(result)
    else this._notifyPendingTransition(result.updates)
    return result.updates
  }

  async update(id: string, options: { silent?: boolean } = {}): Promise<boolean> {
    // Not a raw map lookup: the pending set belongs to one side of one workspace,
    // and an install must never target a host the user has already left. The host is
    // snapshotted before the first await so a switch mid-flight can't retarget it.
    const authority = this._pendingAuthority
    const update = this._pendingBelongsToCurrentWorkspace() ? this._pending.get(id) : undefined
    const entry = this.find(id)
    if (!update || !entry) return false
    // `silent` means "do not prompt", never "skip the trust gate": an update from a
    // publisher the user has not trusted waits for a manual click.
    if (options.silent === true && !(await this._isPublisherTrusted(entry.publisher))) return false
    if (!(await this._ensurePublisherTrusted(entry))) return false

    this._installing.add(id)
    this._onDidChange.fire()
    try {
      await this._management.updateExtension(update, authority)
    } catch (err) {
      this._notification.notify({
        severity: Severity.Error,
        message: localize('extensions.update.failed', 'Failed to update {name}: {error}', {
          name: entry.displayName,
          error: (err as Error).message,
        }),
      })
      return false
    } finally {
      this._installing.delete(id)
    }
    await this.refreshInstalled()
    return true
  }

  async updateAll(
    ids?: readonly string[],
    options: { silent?: boolean } = {},
  ): Promise<IExtensionsUpdateRunResult> {
    const silent = options.silent === true
    // Same rule as `update`: the host the pending set came from, snapshotted before
    // the first await (the trust dialogs below can take arbitrarily long).
    const authority = this._pendingAuthority
    const requested = this._pendingBelongsToCurrentWorkspace()
      ? (ids ?? [...this._pending.keys()])
      : []
    const targets = requested
      .map((id) => this._pending.get(id))
      .filter((update): update is IExtensionUpdate => update !== undefined)
    if (targets.length === 0) return { updated: [], failed: [], skipped: [] }

    // Trust is settled up front and sequentially (the dialog is per publisher), so
    // the install below is one main-process call and the host restarts once.
    const approved: IExtensionUpdate[] = []
    const skipped: string[] = []
    for (const target of targets) {
      const entry = this.find(target.identifier)
      // A pending id with no entry is not a user decision, just a stale item the next
      // refresh prunes — it is neither skipped-for-a-reason nor worth reporting.
      if (!entry) continue
      if (silent) {
        if (await this._isPublisherTrusted(entry.publisher)) approved.push(target)
        else skipped.push(target.identifier)
      } else if (await this._ensurePublisherTrusted(entry)) {
        approved.push(target)
      } else {
        skipped.push(target.identifier)
      }
    }
    if (approved.length === 0) {
      const result: IExtensionsUpdateRunResult = { updated: [], failed: [], skipped }
      this._notifyUpdateRun(result, silent)
      return result
    }

    for (const target of approved) this._installing.add(target.identifier)
    this._onDidChange.fire()
    let outcomes: readonly IExtensionUpdateOutcome[]
    try {
      outcomes = await this._management.updateExtensions(approved, authority)
    } catch (err) {
      const error = (err as Error).message
      outcomes = approved.map((target) => ({ identifier: target.identifier, error }))
    } finally {
      for (const target of approved) this._installing.delete(target.identifier)
    }

    const result: IExtensionsUpdateRunResult = {
      updated: outcomes.filter((o) => o.error === undefined).map((o) => o.identifier),
      failed: outcomes
        .filter((o): o is IExtensionUpdateOutcome & { error: string } => o.error !== undefined)
        .map((o) => ({ identifier: o.identifier, error: o.error })),
      skipped,
    }
    await this.refreshInstalled()
    this._notifyUpdateRun(result, silent)
    return result
  }

  getExtensionsNotification(): IExtensionsNotification | undefined {
    const pending = this.getPendingUpdates()
    if (this._dismissedSignature === this._stripSignature(pending)) return undefined

    if (pending.length > 0) {
      return {
        kind: 'updates',
        severity: Severity.Info,
        message: localize(
          'extensions.updates.available',
          '{count} extension update(s) are available.',
          { count: pending.length },
        ),
        actions: [
          {
            label: localize('extensions.update.all', 'Update All'),
            run: () => void this.updateAll(),
          },
        ],
      }
    }
    if (this._checkOutcome?.kind === 'up-to-date') {
      return {
        kind: 'up-to-date',
        severity: Severity.Info,
        message: localize(
          'action.extensions.checkForUpdates.none',
          'All extensions are up to date.',
        ),
        actions: [],
      }
    }
    if (this._checkOutcome?.kind === 'failed') {
      return {
        kind: 'failed',
        severity: Severity.Warning,
        message: localize('extensions.check.failed', 'Could not check for updates: {error}', {
          error: this._checkOutcome.message ?? '',
        }),
        actions: [
          {
            label: localize('extensions.check.retry', 'Retry'),
            run: () => void this.checkForUpdates({ explicit: true }),
          },
        ],
      }
    }
    return undefined
  }

  dismissExtensionsNotification(): void {
    this._dismissedSignature = this._stripSignature(this.getPendingUpdates())
    this._onDidChange.fire()
  }

  async setAutoUpdateEnabled(id: string, enabled: boolean): Promise<void> {
    if (enabled) this._autoUpdateOptOut.delete(id)
    else this._autoUpdateOptOut.add(id)
    await this._storage.set(
      AUTO_UPDATE_OPT_OUT_KEY,
      [...this._autoUpdateOptOut],
      StorageScope.GLOBAL,
    )
    this._onDidChange.fire()
  }

  /** Strip identity: a new pending set or a new check outcome un-dismisses it. */
  private _stripSignature(pending: readonly IExtensionUpdate[]): string {
    return `${updateSetSignature(pending)}|${this._checkOutcome?.kind ?? ''}`
  }

  /**
   * The pending set was computed for one side of one workspace; a switch makes it
   * stale. `undefined` is a legitimate authority (local), so compare, never test
   * for truthiness.
   */
  private _pendingBelongsToCurrentWorkspace(): boolean {
    return this._pendingAuthority === this._authority
  }

  /**
   * The pending update for `id` on the side the entry belongs to. A check covers
   * one side at a time — in a remote workspace that is the effective (remote) side,
   * so local-side rows show no Update affordance.
   */
  private _pendingFor(id: string, remote: boolean): IExtensionUpdate | undefined {
    if (!this._pendingBelongsToCurrentWorkspace()) return undefined
    if (remote !== (this._pendingAuthority !== undefined)) return undefined
    return this._pending.get(id)
  }

  /** Drop pending updates that no longer apply: gone, or the version caught up. */
  private _prunePendingUpdates(): void {
    if (this._pending.size === 0) return
    const list = this._pendingAuthority !== undefined ? this._remoteInstalled : this._installed
    const versions = new Map(list.map((local) => [local.identifier, local.version]))
    for (const [id, update] of this._pending) {
      const version = versions.get(id)
      if (version === undefined || compareVersions(version, update.toVersion) >= 0) {
        this._pending.delete(id)
      }
    }
  }

  /**
   * A background check announces a *change* in the pending set, at most once per
   * distinct set per session: repeating "3 updates are available" every 12 hours is
   * noise, and the badge + strip keep the state visible without it.
   */
  private _notifyPendingTransition(updates: readonly IExtensionUpdate[]): void {
    const signature = updateSetSignature(updates)
    if (signature === this._notifiedSignature) return
    this._notifiedSignature = signature
    if (updates.length === 0) return
    this._notifyUpdatesAvailable(updates.length)
  }

  /** A user-initiated check always reports its outcome — including "nothing to do". */
  private _notifyExplicitOutcome(result: IExtensionUpdateCheckResult): void {
    if (result.failure !== undefined) {
      this._notification.notify({
        severity: Severity.Warning,
        message: localize('extensions.check.failed', 'Could not check for updates: {error}', {
          error: result.failure,
        }),
      })
      return
    }
    if (result.updates.length === 0) {
      this._notification.notify({
        severity: Severity.Info,
        message: localize(
          'action.extensions.checkForUpdates.none',
          'All extensions are up to date.',
        ),
      })
      return
    }
    this._notifyUpdatesAvailable(result.updates.length)
  }

  private _notifyUpdatesAvailable(count: number): void {
    this._notification.notify({
      severity: Severity.Info,
      message: localize(
        'extensions.updates.available',
        '{count} extension update(s) are available.',
        { count },
      ),
      actions: [
        {
          label: localize('extensions.update.all', 'Update All'),
          run: () => void this.updateAll(),
        },
        {
          label: localize('extensions.update.later', 'Later'),
          isSecondary: true,
          run: () => undefined,
        },
      ],
    })
  }

  /** At most one Info + one Error toast per run, never one per extension. */
  private _notifyUpdateRun(result: IExtensionsUpdateRunResult, silent: boolean): void {
    if (result.updated.length > 0) {
      this._notification.notify({
        severity: Severity.Info,
        message: localize('extensions.updateAll.done', 'Updated {count} extension(s).', {
          count: result.updated.length,
        }),
      })
    }
    if (result.failed.length > 0) {
      this._notification.notify({
        severity: Severity.Error,
        message: localize(
          'extensions.updateAll.failed',
          'Failed to update {count} extension(s): {names}',
          {
            count: result.failed.length,
            names: result.failed.map((failed) => failed.identifier).join(', '),
          },
        ),
      })
    }
    // An automatic run skips untrusted publishers by design and says nothing (the
    // update stays pending in the badge and strip); a run the user asked for owes
    // them an answer when their own trust decision left extensions behind.
    if (!silent && result.skipped.length > 0) {
      this._notification.notify({
        severity: Severity.Info,
        message: localize(
          'extensions.updateAll.skipped',
          'Skipped {count} extension update(s): {names}',
          {
            count: result.skipped.length,
            names: result.skipped.join(', '),
          },
        ),
      })
    }
  }

  private async _loadAutoUpdateOptOut(): Promise<void> {
    const stored = await this._storage.get<string[]>(AUTO_UPDATE_OPT_OUT_KEY, StorageScope.GLOBAL)
    if (!Array.isArray(stored)) return
    for (const id of stored) this._autoUpdateOptOut.add(id)
    this._onDidChange.fire()
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
    const update = this._pendingFor(local.identifier, remote)
    return {
      id: local.identifier,
      displayName: m.displayName ?? m.name,
      publisher: m.publisher ?? '',
      description: m.description ?? '',
      version: local.version,
      installed: true,
      outdated: update !== undefined,
      ...(update !== undefined ? { updateVersion: update.toVersion } : {}),
      ...(this._autoUpdateOptOut.has(local.identifier) ? { autoUpdate: false } : {}),
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
    // Compare against the version install would actually pick, so a gallery whose
    // newest release needs a newer editor doesn't read as outdated.
    const best = picked?.version ?? gallery.version
    return {
      id: gallery.identifier,
      displayName: gallery.displayName,
      publisher: gallery.publisher,
      description: gallery.description,
      version: gallery.version,
      installed: local !== undefined,
      outdated: local !== undefined && compareVersions(best, local.version) > 0,
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
