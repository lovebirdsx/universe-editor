/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the Extension Host process. The main process spawns the
 *  host through Electron's own Node runtime and pumps stdio bytes; the renderer
 *  owns the RPC (platform ChannelServer/ChannelClient over a stdio framing
 *  protocol) on top of these chunks. The handle is opaque — main never exposes
 *  the underlying PID.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export interface ExtHostStdioChunk {
  /** Opaque handle returned by `start()`. */
  readonly handle: string
  /** Text chunk decoded as UTF-8 (the RPC is newline-delimited JSON). */
  readonly data: string
}

export interface ExtHostExitEvent {
  readonly handle: string
  readonly code: number | null
  readonly signal: string | null
  /** Present when the child failed to spawn (e.g. ENOENT); code/signal are null. */
  readonly error?: string
}

export interface ExtHostStartResult {
  readonly handle: string
}

/** Which trust tier an Extension Host runs at. */
export type ExtHostKind = 'trusted' | 'restricted'

/** Launch parameters for the Extension Host. */
export interface ExtHostStartSpec {
  /**
   * Absolute filesystem path of the open workspace folder, surfaced to
   * extensions as `workspace.rootPath`. Omitted when no folder is open.
   */
  readonly workspaceRoot?: string
  /**
   * Trust tier. `trusted` (default) runs built-in extensions with raw Node
   * access. `restricted` runs external extensions: filesystem goes through the
   * main gateway, and (where the runtime supports it) the process is launched
   * under the Node permission model.
   */
  readonly kind?: ExtHostKind
  /**
   * Override the directory scanned for extensions. Defaults per `kind`:
   * trusted → bundled built-in dir; restricted → `<userData>/extensions`.
   */
  readonly extensionsDir?: string
  /**
   * Display locale (e.g. `zh-CN`) used to localize each extension manifest's
   * `%key%` placeholders against its `package.nls.<locale>.json`. Omitted →
   * the default `package.nls.json` (English) bundle.
   */
  readonly locale?: string
}

/**
 * Cross-process bytestream host for the Extension Host subprocess.
 *
 * Lifecycle: `start()` (main resolves the bundled bootstrap entry and launches
 * it via `process.execPath` + `ELECTRON_RUN_AS_NODE`) → emits `onStdout` chunks
 * → `writeStdin` to push renderer→host traffic → `stop(handle)` to terminate.
 * `onExit` always fires exactly once per handle. stderr is forwarded via
 * `onStderr` so the renderer can pipe it into an Output channel for diagnostics.
 */
export interface IExtensionHostService {
  readonly _serviceBrand: undefined

  readonly onStdout: Event<ExtHostStdioChunk>
  readonly onStderr: Event<ExtHostStdioChunk>
  readonly onExit: Event<ExtHostExitEvent>

  start(spec?: ExtHostStartSpec): Promise<ExtHostStartResult>
  writeStdin(handle: string, data: string): Promise<void>
  stop(handle: string): Promise<void>
  /**
   * Gracefully stop every live host and await their exit. Main-only quit
   * primitive (not exposed to the renderer via ProxyChannel): drives the full
   * stdin-EOF shutdown cascade to reap each host's descendants (notably the
   * typescript plugin's tsserver) before the synchronous `will-quit` teardown.
   */
  stopAll(): Promise<void>
  /**
   * Whether the user (external) extensions directory exists and is non-empty.
   * Lets the renderer skip spawning the restricted host when there's nothing to
   * load (the common case today).
   */
  hasUserExtensions(): Promise<boolean>
}

export const IExtensionHostService = createDecorator<IExtensionHostService>('extensionHostService')
