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
  observableValue,
  URI,
  type Event,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type {
  IExtHostWebviews,
  IMainThreadWebviews,
  IWebviewDiffContextDto,
  IWebviewOptionsDto,
} from '@universe-editor/extensions-common'
import type { ExtHostKind } from '../../../shared/ipc/extensionHostService.js'

/** The renderer's live view of one webview panel, consumed by CustomEditorHost. */
export interface IWebviewPanelModel {
  readonly panelHandle: number
  readonly viewType: string
  readonly resource: URI
  /** The iframe document HTML the host set (empty until `resolveCustomEditor` runs). */
  readonly html: IObservable<string>
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

class WebviewPanelModel extends Disposable implements IWebviewPanelModel {
  readonly html: ISettableObservable<string> = observableValue<string>('webviewHtml', '')
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
}

export class WebviewService extends Disposable implements IWebviewService {
  declare readonly _serviceBrand: undefined

  private readonly _providersByViewType = new Map<string, RegisteredProvider>()
  private readonly _extHosts = new Map<ExtHostKind, IExtHostWebviews>()
  private readonly _panels = new Map<number, WebviewPanelModel>()
  /** viewType + owning tier, keyed by panelHandle, so resolve/close route home. */
  private readonly _panelRouting = new Map<number, { viewType: string; kind: ExtHostKind }>()
  private _panelHandle = 0

  private readonly _onDidChangeProviders = this._register(new Emitter<void>())
  readonly onDidChangeProviders = this._onDidChangeProviders.event

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
    void extHost.$resolveCustomEditor(
      provider.providerHandle,
      panelHandle,
      viewType,
      resource.toJSON(),
      diff,
    )
    return panel
  }

  closePanel(panelHandle: number): void {
    const routing = this._panelRouting.get(panelHandle)
    const panel = this._panels.get(panelHandle)
    this._panels.delete(panelHandle)
    this._panelRouting.delete(panelHandle)
    if (routing) void this._extHosts.get(routing.kind)?.$disposeWebviewPanel(panelHandle)
    panel?.dispose()
  }

  setPanelHtml(panelHandle: number, html: string): void {
    this._panels.get(panelHandle)?.html.set(html, undefined)
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
      if (routing.kind === kind) {
        this._panels.get(panelHandle)?.dispose()
        this._panels.delete(panelHandle)
        this._panelRouting.delete(panelHandle)
      }
    }
    if (providersChanged) this._onDidChangeProviders.fire()
  }

  override dispose(): void {
    for (const panel of this._panels.values()) panel.dispose()
    this._panels.clear()
    this._panelRouting.clear()
    this._providersByViewType.clear()
    super.dispose()
  }
}
