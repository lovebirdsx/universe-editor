/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the Agent Client Protocol (ACP) process host. The local
 *  editor main, the renderer, and a remote universe-editor-server daemon all
 *  share this contract so the same handle semantics work regardless of where the
 *  agent subprocess is spawned.
 *
 *  The renderer owns the ACP protocol parsing (newline-delimited JSON-RPC); this
 *  host only spawns the agent and pumps raw stdio bytes. The handle is opaque —
 *  no PID ever crosses the boundary.
 *
 *  Path convention: `AcpLaunchSpec.cwd` is a *string* native path, NOT a URI.
 *  For a local workspace it is a local fsPath; for a remote workspace the
 *  renderer already derived the remote POSIX path (and set `authority`), so the
 *  server-side spawn uses it verbatim with no URI transform. This is the one
 *  documented string-path exception to the "paths in DTOs are URIs" rule —
 *  see `remoteProtocol.ts`.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { Event } from '../base/event.js'

export interface AcpLaunchSpec {
  /** Executable to run (resolved against PATH). */
  readonly command: string
  readonly args: readonly string[]
  /** Extra environment variables merged on top of the inherited env. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory. Defaults to the current workspace folder or HOME. */
  readonly cwd?: string
  /**
   * Run the bundled agent through the host's own Node runtime instead of
   * resolving `command` against PATH. On the local editor this means Electron's
   * Node (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`); on a remote server it
   * means the server's Node (`process.execPath`). The host owns entry-file
   * resolution, so `command`/`args` are advisory only.
   *
   * Trusted flag: it intentionally re-adds the runtime's self-exec env (which the
   * env denylist normally strips) because the agent re-spawns itself via
   * `process.execPath`. Only the built-in registry preset may set it.
   */
  readonly runAsNode?: boolean
  /**
   * Selects which bundled agent entry file the host resolves when `runAsNode` is
   * set. `'claude'` → vendored claude-agent-acp, `'codex'` → vendored codex-acp.
   * Defaults to `'claude'` for backward compatibility.
   */
  readonly nodeEntry?: 'claude' | 'codex'
  /**
   * Force the platform-shell wrapper on or off. Defaults to win32 (so `.cmd`
   * shims resolve). Ignored when `runAsNode` is set (that path always forces
   * shell off).
   */
  readonly shell?: boolean
  /**
   * The `remote-ssh` authority this agent should run on. When set, the local
   * host routes the launch through the remote server's AcpHost channel and the
   * agent process is spawned on that host (cwd is then a remote POSIX path).
   * Absent → spawn locally.
   */
  readonly authority?: string
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
   * `code` and `signal` are both `null`.
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
 * Security: the host enforces an env denylist (ELECTRON_RUN_AS_NODE / NODE_OPTIONS
 * and friends) so a compromised agent cannot reinterpret the host runtime or
 * inject a `--require` payload. stderr is forwarded via `onStderr` so the
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
   * the binary is found by the platform's `where`/`which` lookup.
   */
  probe(command: string): Promise<boolean>
}

export const IAcpHostService = createDecorator<IAcpHostService>('acpHostService')
