/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the ACP terminal pool. Agents under ACP can request
 *  long-running terminal commands (`terminal/create`, `terminal/output`,
 *  `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`); the renderer
 *  translates those JSON-RPC calls into this service so the heavy lifting
 *  (child_process.spawn, stdout buffering, exit bookkeeping) lives in main / the
 *  remote server where `node:child_process` is available.
 *
 *  Types mirror the `@agentclientprotocol/sdk` shapes the renderer passes
 *  through, declared standalone so neither the local main nor the remote server
 *  needs the SDK dependency. `sessionId` is stripped at the renderer boundary
 *  because session routing / ownership lives in renderer; the host only spawns
 *  and bookkeeps the child proc.
 *
 *  Path convention: `cwd` is a *string* native path (same documented exception
 *  as `AcpLaunchSpec.cwd`). For a remote session it is already the remote POSIX
 *  path and `authority` selects the host.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'

export interface AcpTerminalEnvVariable {
  readonly name: string
  readonly value: string
}

/** Spawn-time spec — SDK shape without the renderer-only `sessionId` field. */
export interface AcpTerminalCreateSpec {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: readonly AcpTerminalEnvVariable[]
  /** Working directory. Must be an absolute path. */
  readonly cwd?: string | null
  /** Maximum number of output bytes to retain (head-dropping). */
  readonly outputByteLimit?: number | null
  /** Route the terminal to this `remote-ssh` authority; absent → local. */
  readonly authority?: string
}

export interface AcpTerminalCreatedInfo {
  readonly terminalId: string
}

export interface AcpTerminalExitStatus {
  readonly exitCode?: number | null
  readonly signal?: string | null
}

export interface AcpTerminalOutput {
  readonly output: string
  readonly truncated: boolean
  readonly exitStatus?: AcpTerminalExitStatus | null
}

export interface AcpTerminalWaitExit {
  readonly exitCode?: number | null
  readonly signal?: string | null
}

/**
 * Host-side terminal pool. Lifecycle per terminalId:
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

  create(spec: AcpTerminalCreateSpec): Promise<AcpTerminalCreatedInfo>
  output(terminalId: string): Promise<AcpTerminalOutput>
  waitForExit(terminalId: string): Promise<AcpTerminalWaitExit>
  kill(terminalId: string): Promise<void>
  release(terminalId: string): Promise<void>
}

export const IAcpTerminalService = createDecorator<IAcpTerminalService>('acpTerminalService')
