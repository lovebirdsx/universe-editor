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
} from '@universe-editor/extension-api'
import {
  fsPathToWebviewUrl,
  WEBVIEW_CSP_SOURCE,
  type IMainThreadWebviews,
  type IWebviewDiffContextDto,
  type IWebviewOptionsDto,
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
    const dto: IWebviewOptionsDto = {
      ...(value.enableScripts !== undefined ? { enableScripts: value.enableScripts } : {}),
      ...(value.localResourceRoots !== undefined
        ? {
            localResourceRoots: value.localResourceRoots.map((r) => URI.revive(r)?.fsPath ?? ''),
          }
        : {}),
    }
    void this._rpc.$setWebviewOptions(this._panelHandle, dto)
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
  private _disposed = false

  constructor(
    private readonly _panelHandle: number,
    readonly viewType: string,
    rpc: IMainThreadWebviews,
    diffContext?: WebviewDiffContext,
  ) {
    this.webview = new HostWebview(_panelHandle, rpc)
    if (diffContext) this.diffContext = diffContext
  }

  reveal(): void {
    // Reveal is renderer-owned; the tab already exists. A no-op host-side for now
    // (the panel is created because the user opened the file).
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._onDidDispose.fire()
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
    const panel = new HostWebviewPanel(
      panelHandle,
      viewType,
      this._rpc,
      diff ? reviveDiffContext(diff) : undefined,
    )
    this._panels.set(panelHandle, panel)
    const document = await registered.provider.openCustomDocument(uri)
    this._documents.set(panelHandle, document)
    await registered.provider.resolveCustomEditor(document, panel)
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
