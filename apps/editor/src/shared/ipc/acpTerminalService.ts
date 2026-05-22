/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the main-side ACP terminal pool.
 *
 *  Agents under ACP can request long-running terminal commands (`terminal/create`,
 *  `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`).
 *  The renderer's AcpClientService translates those JSON-RPC calls into this
 *  service so the heavy lifting (child_process.spawn, stdout buffering, exit
 *  bookkeeping) lives in main where `node:child_process` is available.
 *
 *  Security: cwd must be absolute and is validated against the session sandbox
 *  by the renderer before reaching this service; the main side additionally
 *  strips the ELECTRON_RUN_AS_NODE / NODE_OPTIONS env denylist (same set as the
 *  agent host) so a compromised agent cannot reinterpret an Electron helper
 *  binary or inject `--require` payloads through env variables.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

export interface AcpTerminalSpec {
  /** Executable to run (resolved against PATH on the agent's behalf). */
  readonly command: string
  readonly args: readonly string[]
  /** Extra environment variables merged on top of the inherited env. */
  readonly env?: Readonly<Record<string, string>>
  /** Absolute working directory. */
  readonly cwd?: string
  /**
   * Maximum number of bytes of combined stdout+stderr buffered before the
   * head is dropped and `truncated: true` is reported on subsequent reads.
   * Defaults to the service's safety cap when unset.
   */
  readonly outputByteLimit?: number
}

export interface AcpTerminalExitInfo {
  readonly exitCode?: number
  readonly signal?: string
}

export interface AcpTerminalOutputSnapshot {
  readonly output: string
  readonly truncated: boolean
  readonly exitStatus?: AcpTerminalExitInfo
}

export interface AcpTerminalCreateResultWire {
  readonly terminalId: string
}

/**
 * Main-side terminal pool. Lifecycle per terminalId:
 *   create → (output | waitForExit | kill)* → release
 * `release` removes all state; subsequent calls reject with `unknown terminal`.
 * `kill` is best-effort — pass through even if the proc already exited.
 *
 * `waitForExit` is a long-poll: the returned Promise stays pending until the
 * child reports a final status (or `release` is called, in which case it
 * rejects with a stable sentinel message).
 */
export interface IAcpTerminalService {
  readonly _serviceBrand: undefined

  create(spec: AcpTerminalSpec): Promise<AcpTerminalCreateResultWire>
  output(terminalId: string): Promise<AcpTerminalOutputSnapshot>
  waitForExit(terminalId: string): Promise<AcpTerminalExitInfo>
  kill(terminalId: string): Promise<void>
  release(terminalId: string): Promise<void>
}

export const IAcpTerminalService = createDecorator<IAcpTerminalService>('acpTerminalService')
