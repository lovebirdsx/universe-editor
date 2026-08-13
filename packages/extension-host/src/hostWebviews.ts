/**
 * Host-side custom-editor / webview machinery. An extension registers a
 * `CustomReadonlyEditorProvider` for a `viewType`; the renderer creates the
 * editor tab + sandboxed iframe and calls back through `$resolveCustomEditor`,
 * at which point the host opens the document and hands the extension a
 * {@link HostWebviewPanel} whose `webview.html`/`options` writes and
 * `postMessage`s flow to the renderer over {@link IMainThreadWebviews}.
 *
 * Split out of extensionService.ts so the service stays a thin facade. Mirrors
 * the SCM handle model: providers keyed by `providerHandle`, live panels by
 * `panelHandle` (allocated renderer-side and passed in on resolve).
 */
import { Emitter, URI, type Event } from '@universe-editor/platform'
import type {
  CustomDocument,
  CustomEditorOptions,
  CustomReadonlyEditorProvider,
  Disposable,
  UriComponents,
  Webview,
  WebviewDiffContext,
  WebviewOptions,
  WebviewPanel,
  WebviewPanelOnDidChangeViewStateEvent,
} from '@universe-editor/extension-api'
import {
  fsPathToWebviewUrl,
  WEBVIEW_CSP_SOURCE,
  type IMainThreadWebviews,
  type IWebviewDiffContextDto,
  type IWebviewOptionsDto,
  type IWebviewPanelShowOptionsDto,
} from '@universe-editor/extensions-common'

interface RegisteredProvider {
  readonly viewType: string
  readonly provider: CustomReadonlyEditorProvider
  readonly options: CustomEditorOptions | undefined
}

/** Decode a wire diff DTO (base64 bytes) into the public `WebviewDiffContext`. */
function reviveDiffContext(dto: IWebviewDiffContextDto): WebviewDiffContext {
  return {
    leftUri: dto.leftUri,
    rightUri: dto.rightUri,
    left: new Uint8Array(Buffer.from(dto.leftBase64, 'base64')),
    right: new Uint8Array(Buffer.from(dto.rightBase64, 'base64')),
    title: dto.title,
  }
}

/** Serialize public `WebviewOptions` into the wire DTO (URI roots → fsPath). */
function webviewOptionsToDto(value: WebviewOptions | undefined): IWebviewOptionsDto {
  return {
    ...(value?.enableScripts !== undefined ? { enableScripts: value.enableScripts } : {}),
    ...(value?.localResourceRoots !== undefined
      ? {
          localResourceRoots: value.localResourceRoots
            .map((r) => URI.revive(r)?.fsPath)
            // Un-revivable roots must not cross as '' (an empty root would
            // silently widen the resource allow-list).
            .filter((p): p is string => p !== undefined && p !== ''),
        }
      : {}),
  }
}

/** Host-side Webview handle: write-through html/options + two-way messaging. */
class HostWebview implements Webview {
  private _html = ''
  private _options: WebviewOptions = {}
  private readonly _onDidReceiveMessage = new Emitter<unknown>()
  readonly onDidReceiveMessage: Event<unknown> = this._onDidReceiveMessage.event

  constructor(
    private readonly _panelHandle: number,
    private readonly _rpc: IMainThreadWebviews,
  ) {}

  readonly cspSource = WEBVIEW_CSP_SOURCE

  get options(): WebviewOptions {
    return this._options
  }
  set options(value: WebviewOptions) {
    this._options = value
    void this._rpc.$setWebviewOptions(this._panelHandle, webviewOptionsToDto(value))
  }

  get html(): string {
    return this._html
  }
  set html(value: string) {
    this._html = value
    void this._rpc.$setWebviewHtml(this._panelHandle, value)
  }

  asWebviewUri(resource: UriComponents): string {
    return fsPathToWebviewUrl(URI.revive(resource)?.fsPath ?? '')
  }

  postMessage(message: unknown): Promise<boolean> {
    return this._rpc.$postMessageToWebview(this._panelHandle, message)
  }

  /** Deliver a message the renderer relayed from the iframe scripts. */
  acceptMessage(message: unknown): void {
    this._onDidReceiveMessage.fire(message)
  }
}

/** Host-side WebviewPanel handle owned by the workbench editor tab. */
class HostWebviewPanel implements WebviewPanel {
  readonly webview: HostWebview
  readonly diffContext?: WebviewDiffContext
  private readonly _onDidDispose = new Emitter<void>()
  readonly onDidDispose: Event<void> = this._onDidDispose.event
  private readonly _onDidChangeViewState = new Emitter<WebviewPanelOnDidChangeViewStateEvent>()
  readonly onDidChangeViewState: Event<WebviewPanelOnDidChangeViewStateEvent> =
    this._onDidChangeViewState.event
  private readonly _rpc: IMainThreadWebviews
  private _disposed = false
  private _title: string
  private _active = false
  private _visible = false

  constructor(
    private readonly _panelHandle: number,
    readonly viewType: string,
    rpc: IMainThreadWebviews,
    options?: {
      title?: string
      /** True for `window.createWebviewPanel` (extension owns the tab). */
      hostCreated?: boolean
      diffContext?: WebviewDiffContext
      /** Called when the renderer confirmed the panel is gone; lets the manager drop it. */
      onDisposed?: (panel: HostWebviewPanel) => void
    },
  ) {
    this._rpc = rpc
    this._title = options?.title ?? ''
    this._hostCreated = options?.hostCreated === true
    this._onDisposed = options?.onDisposed
    this.webview = new HostWebview(_panelHandle, rpc)
    const dc = options?.diffContext
    if (dc) this.diffContext = dc
    // Custom-editor panels are visible the moment they resolve (their tab just
    // opened); extension-owned panels get their real state from $acceptPanelViewState.
    if (!this._hostCreated) {
      this._active = true
      this._visible = true
    }
  }

  private readonly _hostCreated: boolean
  private readonly _onDisposed: ((panel: HostWebviewPanel) => void) | undefined
  /** Set when the renderer confirmed the tab is gone (acceptPanelDisposed). */
  private _rendererConfirmed = false

  get panelHandle(): number {
    return this._panelHandle
  }

  get title(): string {
    return this._title
  }
  set title(value: string) {
    if (this._title === value) return
    this._title = value
    if (this._hostCreated && !this._disposed) {
      void this._rpc.$setWebviewTitle(this._panelHandle, value)
    }
  }

  get active(): boolean {
    return this._active
  }
  get visible(): boolean {
    return this._visible
  }

  reveal(preserveFocus?: boolean): void {
    // Custom-editor panels: reveal is renderer-owned; the tab already exists (a
    // no-op host-side). Extension-owned panels ask the renderer to re-activate.
    if (this._hostCreated && !this._disposed) {
      void this._rpc.$revealWebviewPanel(this._panelHandle, preserveFocus)
    }
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    // Extension-owned: tell the renderer to close the tab — unless the renderer
    // already confirmed it's gone (acceptPanelDisposed set _rendererConfirmed).
    if (this._hostCreated && !this._rendererConfirmed) {
      void this._rpc.$disposeWebviewPanel(this._panelHandle)
    }
    this._onDidDispose.fire()
    this._onDisposed?.(this)
  }

  /** Renderer → host: the panel's tab is gone (user closed it / host disposed). */
  acceptPanelDisposed(): void {
    // The renderer already tore the tab down, so dispose() must not echo
    // $disposeWebviewPanel back.
    this._rendererConfirmed = true
    this.dispose()
  }

  /** Renderer → host: the panel's view state changed (mount/unmount of its view). */
  acceptPanelViewState(active: boolean, visible: boolean): void {
    if (this._active === active && this._visible === visible) return
    this._active = active
    this._visible = visible
    if (!this._disposed) this._onDidChangeViewState.fire({ webviewPanel: this })
  }

  acceptMessage(message: unknown): void {
    this.webview.acceptMessage(message)
  }
}

/**
 * Owns registered custom-editor providers + live panels. Constructed only when
 * the renderer wired a `mainThreadWebviews` channel (both host tiers get it).
 */
export class HostWebviewManager {
  private readonly _providers = new Map<number, RegisteredProvider>()
  private readonly _providerHandleByViewType = new Map<string, number>()
  private readonly _panels = new Map<number, HostWebviewPanel>()
  private readonly _documents = new Map<number, CustomDocument>()
  private _providerHandle = 0
  /** Negative handle space for extension-owned panels (`createWebviewPanel`). */
  private _hostPanelHandle = 0

  constructor(private readonly _rpc: IMainThreadWebviews) {}

  /** IExtensionHostBridge.registerCustomEditorProvider */
  registerCustomEditorProvider(
    viewType: string,
    provider: CustomReadonlyEditorProvider,
    options?: CustomEditorOptions,
  ): Disposable {
    const handle = this._providerHandle++
    this._providers.set(handle, { viewType, provider, options })
    this._providerHandleByViewType.set(viewType, handle)
    void this._rpc.$registerCustomEditorProvider(handle, viewType)
    return {
      dispose: () => {
        this._providers.delete(handle)
        if (this._providerHandleByViewType.get(viewType) === handle) {
          this._providerHandleByViewType.delete(viewType)
        }
        void this._rpc.$unregisterCustomEditorProvider(handle)
      },
    }
  }

  /** IExtHostWebviews.$resolveCustomEditor — open the document + fill the panel. */
  async resolveCustomEditor(
    providerHandle: number,
    panelHandle: number,
    viewType: string,
    uri: UriComponents,
    diff?: IWebviewDiffContextDto,
  ): Promise<void> {
    const registered = this._providers.get(providerHandle)
    if (!registered) {
      throw new Error(`no custom-editor provider registered for handle ${providerHandle}`)
    }
    const panel = new HostWebviewPanel(panelHandle, viewType, this._rpc, {
      ...(diff ? { diffContext: reviveDiffContext(diff) } : {}),
    })
    this._panels.set(panelHandle, panel)
    const document = await registered.provider.openCustomDocument(uri)
    this._documents.set(panelHandle, document)
    await registered.provider.resolveCustomEditor(document, panel)
  }

  /**
   * IExtensionHostBridge.createWebviewPanel — allocate a NEGATIVE handle
   * (disjoint from the renderer's custom-editor counter), hand back the panel
   * synchronously, and fire-and-forget the create RPC (options ride in the DTO
   * so the renderer can build the model in one shot, no ordering race).
   */
  createWebviewPanel(
    viewType: string,
    title: string,
    options: WebviewOptions | undefined,
    showOptions?: IWebviewPanelShowOptionsDto,
  ): WebviewPanel {
    const panelHandle = -++this._hostPanelHandle
    const panel = new HostWebviewPanel(panelHandle, viewType, this._rpc, {
      title,
      hostCreated: true,
      onDisposed: (p) => {
        // Only drop the map entry if it's still this panel (an accept may have
        // raced a re-create at the same handle in a pathological host).
        if (this._panels.get(panelHandle) === p) this._panels.delete(panelHandle)
      },
    })
    this._panels.set(panelHandle, panel)
    void this._rpc.$createWebviewPanel(
      panelHandle,
      viewType,
      title,
      webviewOptionsToDto(options),
      showOptions,
    )
    return panel
  }

  /** IExtHostWebviews.$acceptPanelDisposed — the renderer closed the tab. */
  acceptPanelDisposed(panelHandle: number): void {
    this._panels.get(panelHandle)?.acceptPanelDisposed()
  }

  /** IExtHostWebviews.$acceptPanelViewState — mount/unmount of the panel's view. */
  acceptPanelViewState(panelHandle: number, active: boolean, visible: boolean): void {
    this._panels.get(panelHandle)?.acceptPanelViewState(active, visible)
  }

  /** IExtHostWebviews.$onDidReceiveMessage */
  acceptMessage(panelHandle: number, message: unknown): void {
    this._panels.get(panelHandle)?.acceptMessage(message)
  }

  /** IExtHostWebviews.$disposeWebviewPanel — the renderer closed the tab. */
  disposePanel(panelHandle: number): void {
    const panel = this._panels.get(panelHandle)
    this._panels.delete(panelHandle)
    const document = this._documents.get(panelHandle)
    this._documents.delete(panelHandle)
    panel?.dispose()
    try {
      document?.dispose()
    } catch {
      // A provider's document.dispose may throw; isolate it so panel teardown completes.
    }
  }

  /** Tear down all live panels/documents on host shutdown. */
  dispose(): void {
    for (const handle of [...this._panels.keys()]) this.disposePanel(handle)
    this._providers.clear()
    this._providerHandleByViewType.clear()
  }
}
