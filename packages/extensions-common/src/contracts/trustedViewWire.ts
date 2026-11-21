/**
 * Trusted-view wire contract shared by the extension host and the renderer.
 *
 * A `contributes.trustedViews` extension ships a browser ESM component that the
 * renderer mounts as a native view / editor tab. The component talks to the
 * extension's host-side provider over these two channels:
 *
 *   renderer component ──ctx.request()──▶ extHostTrustedViews.$request ──▶ provider.handleRequest
 *   provider.postEvent ──▶ mainThreadTrustedViews.$postEvent ──▶ component's onEvent
 *
 * Everything crossing either channel must be JSON-safe (the stdio protocol is
 * newline-delimited JSON). The renderer allocates a session id per component
 * mount; the host owns the provider table and the session table.
 */

import type { CancellationToken } from '@universe-editor/platform'

/**
 * Renderer ← host: provider lifecycle, session events and editor-open requests.
 * The host's ChannelClient calls these on the renderer's ChannelServer.
 */
export interface IMainThreadTrustedViews {
  /**
   * A provider is ready for `viewId`. The renderer validates that
   * `extensionId` declares the view and is trusted before mounting anything.
   */
  $registerProvider(extensionId: string, viewId: string): Promise<void>
  /** The provider (and every session it owned) is gone. */
  $unregisterProvider(viewId: string): Promise<void>
  /** `TrustedViewSession.postEvent` for one mounted component. */
  $postEvent(sessionId: string, name: string, data: unknown): Promise<void>
  /**
   * `context.trustedViews.openEditor`: open (or focus, when `key` matches an open tab
   * of the same view) a trusted-view editor tab.
   */
  $openEditor(extensionId: string, viewId: string, options: ITrustedEditorOpenDto): Promise<void>
}

/**
 * Host ← renderer: session lifecycle and provider requests. The renderer's
 * ChannelClient calls these on the host's ChannelServer.
 */
export interface IExtHostTrustedViews {
  /**
   * A component mounted: create the session and call the provider's
   * `resolveSession`. Rejects when no provider is registered for `viewId`
   * (the renderer race: renderer re-resolves after a host restart).
   */
  $resolveSession(viewId: string, sessionId: string, state: unknown): Promise<void>
  /**
   * A component called `ctx.request(method, ...args)`. The trailing token (if
   * any) arrives through ProxyChannel's cancellation path, like every other
   * cancellable RPC.
   */
  $request(
    sessionId: string,
    method: string,
    args: unknown[],
    token?: CancellationToken,
  ): Promise<unknown>
  /** The component unmounted / tab closed: fire `onDidDispose`, drop the session. */
  $disposeSession(sessionId: string): Promise<void>
}

/** Wire form of `context.trustedViews.openEditor` options (null instead of undefined). */
export interface ITrustedEditorOpenDto {
  title: string | null
  state: unknown
  key: string | null
  preserveFocus: boolean
}
