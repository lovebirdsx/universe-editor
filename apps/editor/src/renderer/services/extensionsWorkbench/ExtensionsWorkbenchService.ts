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
  INotificationService,
  IStorageService,
  Severity,
  StorageScope,
  localize,
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
import {
  IExtensionEnablementService,
  EnablementState,
} from '../extensions/ExtensionEnablementService.js'

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
  /** Whether the extension is currently enabled (resolved global + workspace). */
  readonly enabled: boolean
  /** The resolved enablement state (drives which enable/disable actions to show). */
  readonly enablementState: EnablementState
  /** Source references for actions (present when known). */
  readonly local?: ILocalExtension
  readonly gallery?: IGalleryExtension
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
  private _results: IGalleryExtension[] = []
  private _searchText = ''
  private _searching = false
  /** ids with an install/uninstall in flight. */
  private readonly _installing = new Set<string>()
  /** Monotonic search token so a slow earlier query can't clobber a newer one. */
  private _searchSeq = 0
  /** Resolved enablement state per id, refreshed alongside the installed set. */
  private _enablementStates = new Map<string, EnablementState>()

  constructor(
    @IExtensionManagementService private readonly _management: IExtensionManagementService,
    @IExtensionGalleryService private readonly _gallery: IExtensionGalleryService,
    @IDialogService private readonly _dialog: IDialogService,
    @IStorageService private readonly _storage: IStorageService,
    @INotificationService private readonly _notification: INotificationService,
    @IExtensionEnablementService private readonly _enablement: IExtensionEnablementService,
  ) {
    super()
    this._register(this._management.onDidChangeExtensions(() => void this.refreshInstalled()))
    this._register(this._enablement.onDidChangeEnablement(() => void this.refreshInstalled()))
  }

  get searchText(): string {
    return this._searchText
  }

  get searching(): boolean {
    return this._searching
  }

  isMarketplaceEnabled(): Promise<boolean> {
    return this._gallery.isEnabled()
  }

  hasWorkspace(): boolean {
    return this._enablement.hasWorkspace()
  }

  getInstalled(): IExtensionEntry[] {
    // Built-ins first, then user-installed; both carry enablement state.
    return [...this._builtin, ...this._installed].map((local) => this._entryFromLocal(local))
  }

  getSearchResults(): IExtensionEntry[] {
    return this._results.map((gallery) => this._entryFromGallery(gallery))
  }

  async refreshInstalled(): Promise<void> {
    const [installed, builtin] = await Promise.all([
      this._management.getInstalled(),
      this._management.listBuiltinExtensions(),
    ])
    this._installed = installed
    this._builtin = builtin
    // Resolve enablement for every id in one pass so entry mapping stays sync.
    const ids = [...builtin, ...installed].map((e) => e.identifier)
    const states = await Promise.all(ids.map((id) => this._enablement.getEnablementState(id)))
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

  async install(entry: IExtensionEntry): Promise<void> {
    if (!entry.gallery) throw new Error(`no gallery entry for ${entry.id}`)
    if (!(await this._ensurePublisherTrusted(entry))) return

    this._installing.add(entry.id)
    this._onDidChange.fire()
    try {
      await this._management.installFromGallery(entry.gallery)
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
      await this._management.uninstall(entry.id)
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
    return Promise.resolve('')
  }

  find(id: string): IExtensionEntry | undefined {
    return (
      this.getInstalled().find((e) => e.id === id) ??
      this.getSearchResults().find((e) => e.id === id)
    )
  }

  /** Resolved enablement state for an id (defaults to EnabledGlobally if unknown). */
  private _stateOf(id: string): EnablementState {
    return this._enablementStates.get(id) ?? EnablementState.EnabledGlobally
  }

  private _isEnabledState(state: EnablementState): boolean {
    return state === EnablementState.EnabledGlobally || state === EnablementState.EnabledWorkspace
  }

  private _entryFromLocal(local: ILocalExtension): IExtensionEntry {
    const m = local.manifest
    const state = this._stateOf(local.identifier)
    return {
      id: local.identifier,
      displayName: m.displayName ?? m.name,
      publisher: m.publisher ?? '',
      description: m.description ?? '',
      version: local.version,
      installed: true,
      outdated: false,
      installing: this._installing.has(local.identifier),
      isBuiltin: local.source === 'builtin',
      enabled: this._isEnabledState(state),
      enablementState: state,
      local,
      ...(local.galleryMetadata?.publisherDisplayName
        ? { publisherDisplayName: local.galleryMetadata.publisherDisplayName }
        : {}),
      ...(local.galleryMetadata?.installCount !== undefined
        ? { installCount: local.galleryMetadata.installCount }
        : {}),
    }
  }

  private _entryFromGallery(gallery: IGalleryExtension): IExtensionEntry {
    const local = this._installed.find((l) => l.identifier === gallery.identifier)
    const state = this._stateOf(gallery.identifier)
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
      enabled: local === undefined || this._isEnabledState(state),
      enablementState: state,
      gallery,
      ...(local ? { local } : {}),
      ...(gallery.publisherDisplayName
        ? { publisherDisplayName: gallery.publisherDisplayName }
        : {}),
      ...(gallery.installCount !== undefined ? { installCount: gallery.installCount } : {}),
      ...(gallery.rating !== undefined ? { rating: gallery.rating } : {}),
    }
  }
}
