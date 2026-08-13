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
  Emitter,
  InstantiationType,
  observableValue,
  registerSingleton,
  URI,
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
import { WebviewPanelInput } from '../editor/WebviewPanelInput.js'

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
   * instead of a single-file view.
   */
  openPanel(
    viewType: string,
    resource: URI,
    diff?: IWebviewDiffContextDto,
  ): IWebviewPanelModel | undefined
  /** Close a panel (editor tab closed): notify the host and drop it. */
  closePanel(panelHandle: number): void
  /**
   * An extension-owned panel's editor unmounted/remounted (tab hidden/revealed,
   * group activated/deactivated) — relay the view state to the host. Does NOT
   * close the panel.
   */
  reportPanelViewState(panelHandle: number, active: boolean, visible: boolean): void
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
   * Extension-owned panel (`window.createWebviewPanel`): its editor input and a
   * guard against re-entrant dispose. Custom-editor panels leave both unset —
   * their tab is workbench-owned and closes via `closePanel`.
   */
  readonly input?: WebviewPanelInput
  suppressDisposeNotify?: boolean
}

/** Identity URI for an extension-owned panel (focus registry key + model resource). */
function hostPanelResource(panelHandle: number): URI {
  return URI.from({ scheme: 'webview-panel', path: `/${panelHandle}` })
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
 */
export class MainThreadWebviews implements IMainThreadWebviews {
  constructor(
    private readonly _kind: ExtHostKind,
    private readonly _owner: WebviewService,
  ) {}

  $registerCustomEditorProvider(providerHandle: number, viewType: string): Promise<void> {
    this._owner.registerProvider(this._kind, providerHandle, viewType)
    return Promise.resolve()
  }
  $unregisterCustomEditorProvider(providerHandle: number): Promise<void> {
    this._owner.unregisterProvider(this._kind, providerHandle)
    return Promise.resolve()
  }
  $setWebviewOptions(panelHandle: number, options: IWebviewOptionsDto): Promise<void> {
    this._owner.setPanelOptions(panelHandle, options)
    return Promise.resolve()
  }
  $setWebviewHtml(panelHandle: number, html: string): Promise<void> {
    this._owner.setPanelHtml(panelHandle, html)
    return Promise.resolve()
  }
  $postMessageToWebview(panelHandle: number, message: unknown): Promise<boolean> {
    return Promise.resolve(this._owner.postMessageToPanel(panelHandle, message))
  }
  $createWebviewPanel(
    panelHandle: number,
    viewType: string,
    title: string,
    options: IWebviewOptionsDto,
    showOptions?: IWebviewPanelShowOptionsDto,
  ): Promise<void> {
    this._owner.createHostPanel(this._kind, panelHandle, viewType, title, options, showOptions)
    return Promise.resolve()
  }
  $disposeWebviewPanel(panelHandle: number): Promise<void> {
    this._owner.disposeHostPanel(panelHandle)
    return Promise.resolve()
  }
  $revealWebviewPanel(panelHandle: number, preserveFocus?: boolean): Promise<void> {
    this._owner.revealHostPanel(panelHandle, preserveFocus)
    return Promise.resolve()
  }
  $setWebviewTitle(panelHandle: number, title: string): Promise<void> {
    this._owner.setHostPanelTitle(panelHandle, title)
    return Promise.resolve()
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

  /**
   * Per-host-panel `input.onWillDispose` subscription. Emitter.dispose() does NOT
   * dispose the disposables it handed out, so each subscription must be disposed
   * explicitly (in closePanel / dispose) or the e2e leak gate flags it.
   */
  private readonly _hostPanelSubscriptions = new Map<number, IDisposable>()

  setEditorGroupsAccessor(accessor: () => IEditorGroupsService | undefined): void {
    this._getEditorGroups = accessor
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
    this._panelRouting.set(panelHandle, { viewType, kind: provider.kind })
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
    return panel
  }

  closePanel(panelHandle: number): void {
    const subscription = this._hostPanelSubscriptions.get(panelHandle)
    this._hostPanelSubscriptions.delete(panelHandle)
    subscription?.dispose()
    const routing = this._panelRouting.get(panelHandle)
    const panel = this._panels.get(panelHandle)
    this._panels.delete(panelHandle)
    this._panelRouting.delete(panelHandle)
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
    const input = new WebviewPanelInput(panelHandle, viewType, title, resource)
    const routing: PanelRouting = { viewType, kind, input }
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
    // The tab close disposes the input, whose onWillDispose reports back over
    // $acceptPanelDisposed; the host's dispose is idempotent, but suppress the
    // redundant round-trip anyway.
    routing.suppressDisposeNotify = true
    let closed = false
    for (const group of this._getEditorGroups()?.groups ?? []) {
      if (group.contains(routing.input) && group.closeEditor(routing.input)) closed = true
    }
    if (!closed) {
      // Tab already gone (or never opened) — the input will never dispose on its
      // own, so finish teardown here.
      routing.suppressDisposeNotify = false
      routing.input.dispose()
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

  /** WebviewPanelHost mount/unmount → host `onDidChangeViewState`. */
  reportPanelViewState(panelHandle: number, active: boolean, visible: boolean): void {
    const routing = this._panelRouting.get(panelHandle)
    if (!routing?.input) return
    void this._extHosts.get(routing.kind)?.$acceptPanelViewState(panelHandle, active, visible)
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
        routing.suppressDisposeNotify = true
        let closed = false
        for (const group of this._getEditorGroups()?.groups ?? []) {
          if (group.contains(routing.input) && group.closeEditor(routing.input)) closed = true
        }
        if (!closed) {
          routing.suppressDisposeNotify = false
          routing.input.dispose()
        }
        continue
      }
      this._panels.get(panelHandle)?.dispose()
      this._panels.delete(panelHandle)
      this._panelRouting.delete(panelHandle)
    }
    if (providersChanged) this._onDidChangeProviders.fire()
  }

  override dispose(): void {
    for (const panel of this._panels.values()) panel.dispose()
    this._panels.clear()
    this._panelRouting.clear()
    this._providersByViewType.clear()
    for (const subscription of this._hostPanelSubscriptions.values()) subscription.dispose()
    this._hostPanelSubscriptions.clear()
    super.dispose()
  }
}

registerSingleton(IWebviewService, WebviewService, InstantiationType.Eager)
