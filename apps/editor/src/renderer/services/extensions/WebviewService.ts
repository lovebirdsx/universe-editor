/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side owner of the webview / custom-editor model. Handles the host →
 *  renderer `mainThreadWebviews` channel (provider registration + per-panel
 *  html/options/postMessage) and drives the host back through the `extHostWebviews`
 *  proxy (resolve, message relay, dispose).
 *
 *  Two identity spaces, mirroring the host: custom-editor *providers* are keyed by
 *  the host-allocated `providerHandle` (looked up by `viewType`); live *panels* by
 *  a renderer-allocated `panelHandle`. A panel is created when a CustomEditorHost
 *  React view mounts for an opened resource; it holds the iframe's observable
 *  html/options + the message plumbing, then asks the host to resolve it.
 *
 *  A singleton shared across both host tiers (built-in extensions run in the
 *  trusted tier, external ones in the restricted tier), so each connection wires
 *  its own `extHostWebviews` proxy in via `setExtHost(kind, …)`.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  DisposableMap,
  DisposableStore,
  Emitter,
  InstantiationType,
  markAsSingleton,
  observableValue,
  registerSingleton,
  URI,
  type EditorInput,
  type Event,
  type IDisposable,
  type IEditorGroupsService,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type {
  IExtHostWebviews,
  IMainThreadWebviews,
  IWebviewDiffContextDto,
  IWebviewOptionsDto,
  IWebviewPanelShowOptionsDto,
} from '@universe-editor/extensions-common'
import type { ExtHostKind } from '../../../shared/ipc/extensionHostService.js'
import { hostPanelResource, WebviewPanelInput } from '../editor/WebviewPanelInput.js'

/** The renderer's live view of one webview panel, consumed by CustomEditorHost. */
export interface IWebviewPanelModel {
  readonly panelHandle: number
  readonly viewType: string
  readonly resource: URI
  /** The iframe document HTML the host set (empty until `resolveCustomEditor` runs). */
  readonly html: IObservable<string>
  /**
   * Bumped on every html set, even when the string is identical — an extension
   * re-setting the same html must still re-render the iframe (the html observable
   * dedupes equal values and would swallow it).
   */
  readonly htmlVersion: IObservable<number>
  /** The iframe capabilities + resource roots the host set. */
  readonly options: IObservable<IWebviewOptionsDto>
  /** Fires when the host posts a message to the webview (host → iframe). */
  readonly onMessageToWebview: Event<unknown>
  /** Relay a message the iframe scripts posted back (iframe → host). */
  postMessageFromWebview(message: unknown): void
}

export interface IWebviewService {
  readonly _serviceBrand: undefined
  /** True once some tier registered a custom-editor provider for `viewType`. */
  hasProviderForViewType(viewType: string): boolean
  /** Fires when the set of registered providers changes (a viewType came/went). */
  readonly onDidChangeProviders: Event<void>
  /**
   * Open a panel for `resource` under `viewType` and ask the owning host to
   * resolve it. Returns the panel model (its html/options populate async) or
   * undefined when no provider is registered for the viewType. Pass `diff` to
   * open the panel as a two-content comparison (`_workbench.openWebviewDiff`)
   * instead of a single-file view. Pass `editor` — the input whose tab this
   * panel renders — so panel view state (active/visible) can track the editor
   * groups; omitted, view state stays at the host-side initial values.
   */
  openPanel(
    viewType: string,
    resource: URI,
    diff?: IWebviewDiffContextDto,
    editor?: EditorInput,
  ): IWebviewPanelModel | undefined
  /** Close a panel (editor tab closed): notify the host and drop it. */
  closePanel(panelHandle: number): void
  /** Look up a live panel model (WebviewPanelHost renders the one it got from create). */
  getPanel(panelHandle: number): IWebviewPanelModel | undefined
  /** Wire a host tier's proxy once its connection is up. */
  setExtHost(kind: ExtHostKind, extHost: IExtHostWebviews): void
  /** Build the per-tier host → renderer `mainThreadWebviews` channel implementation. */
  createMainThread(kind: ExtHostKind): IMainThreadWebviews
  /** Drop a tier's providers/panels when its connection tears down. */
  reset(kind: ExtHostKind): void
}

export const IWebviewService = createDecorator<IWebviewService>('webviewService')

interface RegisteredProvider {
  readonly providerHandle: number
  readonly kind: ExtHostKind
}

interface PanelRouting {
  readonly viewType: string
  readonly kind: ExtHostKind
  /**
   * The editor input whose tab this panel renders. Set for extension-owned
   * panels (same instance as `input`) and for custom-editor panels when the
   * hosting view passed its input to `openPanel` — the source of truth for the
   * panel's tracked view state.
   */
  readonly editor?: EditorInput
  /**
   * Extension-owned panel (`window.createWebviewPanel`): its editor input and a
   * guard against re-entrant dispose. Custom-editor panels leave both unset —
   * their tab is workbench-owned and closes via `closePanel`.
   */
  readonly input?: WebviewPanelInput
  suppressDisposeNotify?: boolean
}

class WebviewPanelModel extends Disposable implements IWebviewPanelModel {
  readonly html: ISettableObservable<string> = observableValue<string>('webviewHtml', '')
  // Bumped on every $setWebviewHtml, even when the html string is identical —
  // an extension re-setting the same html (e.g. a file-watcher reloading a
  // preview after the file changed on disk) must still re-render the iframe;
  // the observable dedupes equal values and would otherwise swallow it.
  readonly htmlVersion: ISettableObservable<number> = observableValue<number>(
    'webviewHtmlVersion',
    0,
  )
  readonly options: ISettableObservable<IWebviewOptionsDto> = observableValue<IWebviewOptionsDto>(
    'webviewOptions',
    {},
  )
  private readonly _onMessageToWebview = this._register(new Emitter<unknown>())
  readonly onMessageToWebview = this._onMessageToWebview.event

  constructor(
    readonly panelHandle: number,
    readonly viewType: string,
    readonly resource: URI,
    private readonly _postToHost: (message: unknown) => void,
  ) {
    super()
  }

  postMessageFromWebview(message: unknown): void {
    this._postToHost(message)
  }

  /** Host → renderer: the host posted a message aimed at the iframe scripts. */
  acceptMessageToWebview(message: unknown): void {
    this._onMessageToWebview.fire(message)
  }
}

/**
 * Per-tier implementation of the host → renderer `mainThreadWebviews` channel.
 * The shared WebviewService creates one per connection so provider handles and
 * panel routing stay attributable to the owning tier.
 *
 * Host-panel calls (NEGATIVE handle space — hostWebviews.ts allocates extension-
 * owned panels there; custom-editor panels occupy the renderer's non-negative
 * counter) run once the owner's editor-groups hook is wired. main.tsx wires it
 * during bootstrap, long before any host connects, so the sync fast path is the
 * only path in practice; until then calls queue behind the wiring, in stream
 * order, instead of dying silently — an unqueued createWebviewPanel would hand
 * the extension a "live" panel whose tab can never open (and any follow-up
 * html/message would no-op).
 */
export class MainThreadWebviews implements IMainThreadWebviews {
  constructor(
    private readonly _kind: ExtHostKind,
    private readonly _owner: WebviewService,
  ) {}

  private _whenWired<T>(label: string, op: () => T): Promise<T> {
    if (this._owner.isEditorGroupsWired) return Promise.resolve(op())
    console.warn(`[webview] ${label} received before editor groups wiring is in place; queued`)
    return this._owner.whenEditorGroupsWired.then(() =>
      this._owner.isDisposed ? undefined : op(),
    ) as Promise<T>
  }

  /** Gate only the negative (extension-owned) handle space behind the wiring. */
  private _whenWiredIfHostPanel<T>(label: string, panelHandle: number, op: () => T): Promise<T> {
    if (panelHandle >= 0) return Promise.resolve(op())
    return this._whenWired(label, op)
  }

  $registerCustomEditorProvider(providerHandle: number, viewType: string): Promise<void> {
    this._owner.registerProvider(this._kind, providerHandle, viewType)
    return Promise.resolve()
  }
  $unregisterCustomEditorProvider(providerHandle: number): Promise<void> {
    this._owner.unregisterProvider(this._kind, providerHandle)
    return Promise.resolve()
  }
  $setWebviewOptions(panelHandle: number, options: IWebviewOptionsDto): Promise<void> {
    return this._whenWiredIfHostPanel('$setWebviewOptions', panelHandle, () =>
      this._owner.setPanelOptions(panelHandle, options),
    )
  }
  $setWebviewHtml(panelHandle: number, html: string): Promise<void> {
    return this._whenWiredIfHostPanel('$setWebviewHtml', panelHandle, () =>
      this._owner.setPanelHtml(panelHandle, html),
    )
  }
  $postMessageToWebview(panelHandle: number, message: unknown): Promise<boolean> {
    return this._whenWiredIfHostPanel('$postMessageToWebview', panelHandle, () =>
      this._owner.postMessageToPanel(panelHandle, message),
    )
  }
  $createWebviewPanel(
    panelHandle: number,
    viewType: string,
    title: string,
    options: IWebviewOptionsDto,
    showOptions?: IWebviewPanelShowOptionsDto,
  ): Promise<void> {
    return this._whenWired('$createWebviewPanel', () =>
      this._owner.createHostPanel(this._kind, panelHandle, viewType, title, options, showOptions),
    )
  }
  $disposeWebviewPanel(panelHandle: number): Promise<void> {
    return this._whenWiredIfHostPanel('$disposeWebviewPanel', panelHandle, () =>
      this._owner.disposeHostPanel(panelHandle),
    )
  }
  $revealWebviewPanel(panelHandle: number, preserveFocus?: boolean): Promise<void> {
    return this._whenWiredIfHostPanel('$revealWebviewPanel', panelHandle, () =>
      this._owner.revealHostPanel(panelHandle, preserveFocus),
    )
  }
  $setWebviewTitle(panelHandle: number, title: string): Promise<void> {
    return this._whenWiredIfHostPanel('$setWebviewTitle', panelHandle, () =>
      this._owner.setHostPanelTitle(panelHandle, title),
    )
  }
}

export class WebviewService extends Disposable implements IWebviewService {
  declare readonly _serviceBrand: undefined

  private readonly _providersByViewType = new Map<string, RegisteredProvider>()
  private readonly _extHosts = new Map<ExtHostKind, IExtHostWebviews>()
  private readonly _panels = new Map<number, WebviewPanelModel>()
  /** viewType + owning tier, keyed by panelHandle, so resolve/close route home. */
  private readonly _panelRouting = new Map<number, PanelRouting>()
  private _panelHandle = 0

  private readonly _onDidChangeProviders = this._register(new Emitter<void>())
  readonly onDidChangeProviders = this._onDidChangeProviders.event

  /**
   * Editor groups are looked up lazily through this hook rather than injected:
   * the service is an Eager singleton and materialises before IEditorGroupsService
   * is registered in the bootstrap ServiceCollection. main.tsx wires the hook
   * right after the editor services are set.
   */
  private _getEditorGroups: () => IEditorGroupsService | undefined = () => undefined
  private _resolveWhenEditorGroupsWired: (() => void) | undefined
  private readonly _whenEditorGroupsWired = new Promise<void>((resolve) => {
    this._resolveWhenEditorGroupsWired = resolve
  })

  /** True once main.tsx wired the editor-groups hook (host panel tabs can open). */
  get isEditorGroupsWired(): boolean {
    return this._resolveWhenEditorGroupsWired === undefined
  }

  /** True once dispose() ran — queued MainThreadWebviews calls no-op after this. */
  get isDisposed(): boolean {
    return this._store.isDisposed
  }

  /** Resolves once the hook is wired; queued MainThreadWebviews calls replay then. */
  get whenEditorGroupsWired(): Promise<void> {
    return this._whenEditorGroupsWired
  }

  /**
   * Per-host-panel `input.onWillDispose` subscription. Emitter.dispose() does NOT
   * dispose the disposables it handed out, so each subscription must be disposed
   * explicitly (closePanel) or with the service — the DisposableMap both parents
   * them for leak tracking and flushes them in dispose().
   */
  private readonly _hostPanelSubscriptions = this._register(new DisposableMap<number>())

  /**
   * Last view state each panel's host was told (`active,visible` as bits). The
   * editor-group tracker recomputes on every relevant group event and only
   * sends transitions; the host additionally dedupes against its own state.
   */
  private readonly _reportedViewStates = new Map<number, string>()
  /** Editor-group subscriptions driving panel view state; wired once, at bootstrap. */
  private _panelViewStateTracking: IDisposable | undefined

  setEditorGroupsAccessor(accessor: () => IEditorGroupsService | undefined): void {
    this._getEditorGroups = accessor
    this._resolveWhenEditorGroupsWired?.()
    this._resolveWhenEditorGroupsWired = undefined
    this._panelViewStateTracking?.dispose()
    this._panelViewStateTracking = undefined
    const groups = accessor()
    if (groups) {
      this._panelViewStateTracking = this._trackPanelViewStates(groups)
      this._recomputePanelViewStates()
    }
  }

  /**
   * Panel view state is derived from the editor groups, not from view
   * mount/unmount: `visible` = the panel's tab is its group's active editor;
   * `active` = and that group is the focused group. Subscribing to active-group
   * and per-group active-editor changes covers tab switches, split focus moves
   * and tab drags; creation paths call the recompute explicitly for their
   * initial report (a preserveFocus open fires no active-editor event).
   */
  private _trackPanelViewStates(groups: IEditorGroupsService): IDisposable {
    // The wiring happens once at bootstrap and outlives window teardown (the
    // service is an undisposed Eager singleton on reload) — mark the root so
    // the leak gate doesn't flag these intentionally-long-lived subscriptions.
    const store = markAsSingleton(new DisposableStore())
    const recompute = (): void => this._recomputePanelViewStates()
    const groupSubscriptions = new DisposableMap<number>()
    store.add(groupSubscriptions)
    store.add(groups.onDidActiveGroupChange(recompute))
    store.add(
      groups.onDidAddGroup((group) => {
        groupSubscriptions.set(group.id, group.onDidActiveEditorChange(recompute))
        recompute()
      }),
    )
    store.add(
      groups.onDidRemoveGroup((group) => {
        groupSubscriptions.deleteAndDispose(group.id)
        recompute()
      }),
    )
    for (const group of groups.groups) {
      groupSubscriptions.set(group.id, group.onDidActiveEditorChange(recompute))
    }
    return store
  }

  private _recomputePanelViewStates(): void {
    const groups = this._getEditorGroups()
    if (!groups) return
    for (const [panelHandle, routing] of this._panelRouting) {
      const editor = routing.editor ?? routing.input
      if (!editor) continue
      let active = false
      let visible = false
      for (const group of groups.groups) {
        // Identity goes through findEditor: the group model dedupes same-id
        // inputs, so the instance held here may differ from the group's one.
        const canonical = group.findEditor(editor)
        if (!canonical) continue
        visible = group.activeEditor === canonical
        active = visible && group.isActive
        break
      }
      const key = `${active ? 1 : 0}${visible ? 1 : 0}`
      if (this._reportedViewStates.get(panelHandle) === key) continue
      this._reportedViewStates.set(panelHandle, key)
      console.debug(`[webview] panel ${panelHandle} viewState active=${active} visible=${visible}`)
      void this._extHosts.get(routing.kind)?.$acceptPanelViewState(panelHandle, active, visible)
    }
  }

  setExtHost(kind: ExtHostKind, extHost: IExtHostWebviews): void {
    this._extHosts.set(kind, extHost)
  }

  /** Build the per-tier mainThread channel implementation. */
  createMainThread(kind: ExtHostKind): MainThreadWebviews {
    return new MainThreadWebviews(kind, this)
  }

  hasProviderForViewType(viewType: string): boolean {
    return this._providersByViewType.has(viewType)
  }

  registerProvider(kind: ExtHostKind, providerHandle: number, viewType: string): void {
    this._providersByViewType.set(viewType, { providerHandle, kind })
    this._onDidChangeProviders.fire()
  }

  unregisterProvider(kind: ExtHostKind, providerHandle: number): void {
    for (const [viewType, reg] of this._providersByViewType) {
      if (reg.kind === kind && reg.providerHandle === providerHandle) {
        this._providersByViewType.delete(viewType)
        this._onDidChangeProviders.fire()
        break
      }
    }
  }

  openPanel(
    viewType: string,
    resource: URI,
    diff?: IWebviewDiffContextDto,
    editor?: EditorInput,
  ): IWebviewPanelModel | undefined {
    const provider = this._providersByViewType.get(viewType)
    if (!provider) return undefined
    const extHost = this._extHosts.get(provider.kind)
    if (!extHost) return undefined

    const panelHandle = this._panelHandle++
    const panel = new WebviewPanelModel(panelHandle, viewType, resource, (message) => {
      void extHost.$onDidReceiveMessage(panelHandle, message)
    })
    this._panels.set(panelHandle, panel)
    this._panelRouting.set(panelHandle, {
      viewType,
      kind: provider.kind,
      ...(editor ? { editor } : {}),
    })
    void extHost
      .$resolveCustomEditor(provider.providerHandle, panelHandle, viewType, resource.toJSON(), diff)
      .catch((err: unknown) => {
        // Without this the rejection is swallowed and the panel html stays ''
        // forever — a blank tab with zero feedback (host-side resolve throw,
        // host crash mid-resolve). Surface the failure in the panel itself.
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[webview] resolveCustomEditor failed for ${viewType}: ${message}`)
        const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        this._panels
          .get(panelHandle)
          ?.html.set(
            `<!DOCTYPE html><html><body style="font-family: system-ui, sans-serif; padding: 16px;">Failed to open this editor: ${escaped}</body></html>`,
            undefined,
          )
      })
    // Initial view-state report rides the stream AFTER $resolveCustomEditor, so
    // the host panel exists by the time the state arrives.
    this._recomputePanelViewStates()
    return panel
  }

  closePanel(panelHandle: number): void {
    this._hostPanelSubscriptions.deleteAndDispose(panelHandle)
    const routing = this._panelRouting.get(panelHandle)
    const panel = this._panels.get(panelHandle)
    this._panels.delete(panelHandle)
    this._panelRouting.delete(panelHandle)
    this._reportedViewStates.delete(panelHandle)
    if (routing?.input) {
      // Extension-owned: tell the host its panel is gone — unless the host
      // initiated this teardown itself (suppressDisposeNotify).
      if (!routing.suppressDisposeNotify) {
        void this._extHosts.get(routing.kind)?.$acceptPanelDisposed(panelHandle)
      }
    } else if (routing) {
      void this._extHosts.get(routing.kind)?.$disposeWebviewPanel(panelHandle)
    }
    panel?.dispose()
  }

  /** The tab is closed by the user → input.onWillDispose → closePanel → `$acceptPanelDisposed`. */
  createHostPanel(
    kind: ExtHostKind,
    panelHandle: number,
    viewType: string,
    title: string,
    options: IWebviewOptionsDto,
    showOptions?: IWebviewPanelShowOptionsDto,
  ): void {
    if (this._panelRouting.has(panelHandle)) {
      console.error(`[webview] duplicate createWebviewPanel for handle ${panelHandle}; ignored`)
      return
    }
    // Bail out before creating anything: without editor groups the tab can't open
    // and the input would sit undisposed forever (leak-gate flagged).
    const groups = this._getEditorGroups()
    if (!groups) {
      console.error('[webview] createWebviewPanel before editor groups are ready; tab not opened')
      return
    }
    const extHost = this._extHosts.get(kind)
    const resource = hostPanelResource(panelHandle)
    const panel = new WebviewPanelModel(panelHandle, viewType, resource, (message) => {
      void extHost?.$onDidReceiveMessage(panelHandle, message)
    })
    panel.options.set(options, undefined)
    const input = new WebviewPanelInput(panelHandle, viewType, title)
    const routing: PanelRouting = { viewType, kind, input, editor: input }
    this._panels.set(panelHandle, panel)
    this._panelRouting.set(panelHandle, routing)
    // The user closing the tab disposes the input (group owns it via its store).
    // Route through closePanel so the suppressDisposeNotify guard (host-initiated
    // teardown) is honored; it's idempotent for a handle already removed.
    this._hostPanelSubscriptions.set(
      panelHandle,
      input.onWillDispose(() => this.closePanel(panelHandle)),
    )
    // openEditor would dedupe a same-id input and dispose ours as an orphan;
    // guard so a racing double-open can't kill the live tab's input.
    groups.activeGroupForOpen.openEditor(input, {
      pinned: true,
      activate: showOptions?.preserveFocus !== true,
      preserveFocus: showOptions?.preserveFocus === true,
    })
    console.debug(`[webview] host panel created handle=${panelHandle} viewType=${viewType}`)
  }

  /** Host `WebviewPanel.dispose()` → close the tab (input dispose finishes the rest). */
  disposeHostPanel(panelHandle: number): void {
    const routing = this._panelRouting.get(panelHandle)
    if (!routing?.input) return
    this._closeHostPanelTab(routing, routing.input)
  }

  /**
   * Close an extension-owned panel's tab, echoing nothing back to the host. The
   * close itself disposes the input, whose onWillDispose runs closePanel — the
   * suppressed $acceptPanelDisposed keeps a host-initiated teardown from echoing
   * a redundant round-trip. When the tab is already gone (or never opened) the
   * input will never dispose on its own, so dispose it directly instead.
   */
  private _closeHostPanelTab(routing: PanelRouting, input: WebviewPanelInput): void {
    routing.suppressDisposeNotify = true
    let closed = false
    for (const group of this._getEditorGroups()?.groups ?? []) {
      if (group.contains(input) && group.closeEditor(input)) closed = true
    }
    if (!closed) {
      routing.suppressDisposeNotify = false
      input.dispose()
    }
  }

  /** Host `WebviewPanel.reveal()` → re-activate the existing tab. */
  revealHostPanel(panelHandle: number, preserveFocus?: boolean): void {
    const routing = this._panelRouting.get(panelHandle)
    if (!routing?.input) return
    const groups = this._getEditorGroups()
    if (!groups) return
    for (const group of groups.groups) {
      if (group.contains(routing.input)) {
        group.setActive(routing.input, { preserveFocus: preserveFocus === true })
        if (!group.isActive && preserveFocus !== true) groups.activateGroup(group)
        return
      }
    }
    console.debug(`[webview] revealWebviewPanel for handle ${panelHandle}: tab not found`)
  }

  setHostPanelTitle(panelHandle: number, title: string): void {
    this._panelRouting.get(panelHandle)?.input?.setTitle(title)
  }

  getPanel(panelHandle: number): IWebviewPanelModel | undefined {
    return this._panels.get(panelHandle)
  }

  setPanelHtml(panelHandle: number, html: string): void {
    const panel = this._panels.get(panelHandle)
    if (!panel) return
    panel.html.set(html, undefined)
    panel.htmlVersion.set(panel.htmlVersion.get() + 1, undefined)
  }

  setPanelOptions(panelHandle: number, options: IWebviewOptionsDto): void {
    this._panels.get(panelHandle)?.options.set(options, undefined)
  }

  postMessageToPanel(panelHandle: number, message: unknown): boolean {
    const panel = this._panels.get(panelHandle)
    if (!panel) return false
    panel.acceptMessageToWebview(message)
    return true
  }

  reset(kind: ExtHostKind): void {
    this._extHosts.delete(kind)
    let providersChanged = false
    for (const [viewType, reg] of [...this._providersByViewType]) {
      if (reg.kind === kind) {
        this._providersByViewType.delete(viewType)
        providersChanged = true
      }
    }
    for (const [panelHandle, routing] of [...this._panelRouting]) {
      if (routing.kind !== kind) continue
      if (routing.input) {
        // Extension-owned panel: close its tab. The dying host needs no
        // $acceptPanelDisposed echo.
        this._closeHostPanelTab(routing, routing.input)
        continue
      }
      this._panels.get(panelHandle)?.dispose()
      this._panels.delete(panelHandle)
      this._panelRouting.delete(panelHandle)
      this._reportedViewStates.delete(panelHandle)
    }
    if (providersChanged) this._onDidChangeProviders.fire()
  }

  override dispose(): void {
    // Release calls queued behind the wiring; their isDisposed guard no-ops them.
    this._resolveWhenEditorGroupsWired?.()
    this._resolveWhenEditorGroupsWired = undefined
    this._panelViewStateTracking?.dispose()
    this._panelViewStateTracking = undefined
    this._reportedViewStates.clear()
    for (const panel of this._panels.values()) panel.dispose()
    this._panels.clear()
    this._panelRouting.clear()
    this._providersByViewType.clear()
    super.dispose()
  }
}

registerSingleton(IWebviewService, WebviewService, InstantiationType.Eager)
