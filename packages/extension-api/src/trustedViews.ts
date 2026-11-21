/**
 * Trusted views — the host half of a `contributes.trustedViews` extension.
 *
 * The extension registers a {@link TrustedViewProvider} from its `activate`;
 * each mounted renderer component becomes a {@link TrustedViewSession}. The
 * component's `ctx.request()` arrives as `$request` on `extHostTrustedViews`,
 * and `session.postEvent()` goes back out over `mainThreadTrustedViews`.
 * The renderer owns the actual component, its manifest contribution and the
 * trust decision; the host only enforces that `viewId` is declared by an
 * extension manifest (the renderer-side trust list is the real gate).
 */
import type { CancellationToken, Disposable, Event } from './util.js'

/** One mounted renderer component, as seen by the extension. */
export interface TrustedViewSession {
  /** Renderer-allocated id; one per component mount. */
  readonly id: string
  readonly viewId: string
  /** Editor: state passed to `openTrustedEditor`; view: undefined. */
  readonly state: unknown
  /** Push an event to the component's `ctx.onEvent` listeners. */
  postEvent(name: string, data?: unknown): void
  /** Component unmounted / tab closed / host torn down. */
  readonly onDidDispose: Event<void>
}

/**
 * The extension-side counterpart of a trusted-view component. `handleRequest`
 * services `ctx.request()`; `resolveSession` runs once per component mount.
 * Arguments and return values must be JSON-safe.
 */
export interface TrustedViewProvider {
  resolveSession?(session: TrustedViewSession): void | Promise<void>
  handleRequest(
    session: TrustedViewSession,
    method: string,
    args: readonly unknown[],
    token: CancellationToken,
  ): unknown | Promise<unknown>
}

/**
 * `context.trustedViews`: the host half of `contributes.trustedViews`, scoped
 * to the extension whose `activate` received this context. Every call is
 * validated against that extension's own manifest — `viewId` must be declared
 * there, so one extension cannot register or open another extension's views.
 */
export interface TrustedViewsApi {
  /**
   * Register the provider for a `contributes.trustedViews` entry declared by
   * this extension. Each mounted renderer component becomes a
   * {@link TrustedViewSession}. Dispose the returned value (push it onto
   * `context.subscriptions`) to unregister and dispose every live session.
   */
  registerProvider(viewId: string, provider: TrustedViewProvider): Disposable
  /**
   * Open (or focus) a trusted-view editor tab for a `location: "editor"`
   * contribution declared by this extension. `options.key` focuses an
   * already-open tab of the same view instead of opening a new one.
   */
  openEditor(viewId: string, options?: OpenTrustedEditorOptions): Promise<void>
}

/** Options for {@link TrustedViewsApi.openEditor}. */
export interface OpenTrustedEditorOptions {
  readonly title?: string
  /** Persisted so the editor tab can be restored; must be JSON-serializable. */
  readonly state?: unknown
  /** Same `viewId` + `key` focuses the existing tab instead of opening a new one. */
  readonly key?: string
  readonly preserveFocus?: boolean
}
