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

/**
 * Identifies an Extension Host. There is a single local host now (Workspace
 * Trust gates activation at runtime rather than splitting extensions across
 * processes), so this has one value — kept as a named type because the webview
 * router keys panel ownership on it.
 */
export type ExtHostKind = 'local'

/** Launch parameters for the Extension Host. */
export interface ExtHostStartSpec {
  /**
   * Absolute filesystem path of the open workspace folder, surfaced to
   * extensions as `workspace.rootPath`. Omitted when no folder is open.
   */
  readonly workspaceRoot?: string
  /**
   * Override the built-in extensions directory the host scans. Defaults to the
   * bundled built-in dir. Tests inject a fixture dir here.
   */
  readonly extensionsDir?: string
  /**
   * Override the user (external) extensions directory the host scans, in
   * addition to the built-in dir. Defaults to `<userData>/extensions`.
   */
  readonly userExtensionsDir?: string
  /**
   * Display locale (e.g. `zh-CN`) used to localize each extension manifest's
   * `%key%` placeholders against its `package.nls.<locale>.json`. Omitted →
   * the default `package.nls.json` (English) bundle.
   */
  readonly locale?: string
  /**
   * Identifiers to skip when scanning (disabled / quarantined extensions).
   * A disabled extension is filtered out of the scan entirely, so it never
   * activates.
   */
  readonly disabledIds?: readonly string[]
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
   * Lets the renderer decide whether to include external extensions in the scan.
   */
  hasUserExtensions(): Promise<boolean>
}

export const IExtensionHostService = createDecorator<IExtensionHostService>('extensionHostService')
