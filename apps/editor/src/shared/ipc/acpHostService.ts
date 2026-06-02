/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the main-side Agent Client Protocol (ACP) process host.
 *  Main spawns the agent subprocess and pumps stdio bytes; renderer owns the
 *  ACP protocol parsing on top of these chunks. The handle is opaque — main
 *  never exposes the underlying PID.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export interface AcpLaunchSpec {
  /** Executable to run (resolved against PATH). */
  readonly command: string
  readonly args: readonly string[]
  /** Extra environment variables merged on top of the inherited env. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory. Defaults to the current workspace folder or HOME. */
  readonly cwd?: string
  /**
   * Launch the bundled Claude agent through Electron's own Node runtime
   * (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`) instead of resolving
   * `command` against PATH. Main owns the entry-file resolution (dev tree vs
   * packaged `resourcesPath`), so `command`/`args` here are advisory only.
   *
   * Trusted flag: it intentionally re-adds `ELECTRON_RUN_AS_NODE` (which the env
   * denylist normally strips) because the agent re-spawns itself via
   * `process.execPath`. Only the built-in registry preset may set it — it is
   * never honored from user `acp.agents` config.
   */
  readonly runAsNode?: boolean
  /**
   * Force the platform-shell wrapper on or off. Defaults to win32 (so `.cmd`
   * shims like `npx` resolve). Set `false` when `command` is an absolute path to
   * a real binary that may contain spaces (e.g. the downloaded codex-acp under
   * `%APPDATA%/Universe Editor/...`), which a shell wrapper would mis-quote.
   * Ignored when `runAsNode` is set (that path always forces shell off).
   */
  readonly shell?: boolean
}

export interface AcpStdioChunk {
  /** Opaque handle returned by `start()`. */
  readonly handle: string
  /** Text chunk decoded as UTF-8 (ACP is newline-delimited JSON-RPC). */
  readonly data: string
}

export interface AcpExitEvent {
  readonly handle: string
  readonly code: number | null
  readonly signal: string | null
  /**
   * Present when the child failed to start (e.g. spawn ENOENT). When set,
   * `code` and `signal` are both `null` because the process never reached a
   * normal exit. Consumers should prefer this string for user-facing messages.
   */
  readonly error?: string
}

export interface AcpStartResult {
  readonly handle: string
}

/**
 * Cross-process bytestream host for ACP agent subprocesses.
 *
 * Lifecycle: `start(spec)` → emits `onStdout` chunks → `writeStdin` to push
 * client→agent traffic → `stop(handle)` to terminate. `onExit` always fires
 * exactly once per handle.
 *
 * Security: main may enforce a whitelist of allowed commands so the renderer
 * cannot spawn arbitrary executables. stderr is forwarded via `onStderr` so the
 * renderer can pipe it into a dedicated Output channel for diagnostics.
 */
export interface IAcpHostService {
  readonly _serviceBrand: undefined

  readonly onStdout: Event<AcpStdioChunk>
  readonly onStderr: Event<AcpStdioChunk>
  readonly onExit: Event<AcpExitEvent>

  start(spec: AcpLaunchSpec): Promise<AcpStartResult>
  writeStdin(handle: string, data: string): Promise<void>
  stop(handle: string): Promise<void>
  /**
   * Resolve `command` against PATH without launching the agent. Returns true if
   * the binary is found by the platform's `where`/`which` lookup. Used to
   * surface "agent not installed" in the picker before the user hits a wall.
   */
  probe(command: string): Promise<boolean>
}

export const IAcpHostService = createDecorator<IAcpHostService>('acpHostService')
