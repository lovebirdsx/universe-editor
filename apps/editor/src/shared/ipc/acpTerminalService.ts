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
 *  Types pass through from `@agentclientprotocol/sdk` unchanged — main owns the
 *  protocol shape so renderer can passthrough without re-shaping fields.
 *  `sessionId` is stripped at the renderer boundary because session routing /
 *  ownership lives in renderer; main only spawns and bookkeeps the child proc.
 *
 *  Security: cwd must be absolute and is validated against the session sandbox
 *  by the renderer before reaching this service; the main side additionally
 *  strips the ELECTRON_RUN_AS_NODE / NODE_OPTIONS env denylist (same set as the
 *  agent host) so a compromised agent cannot reinterpret an Electron helper
 *  binary or inject `--require` payloads through env variables.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'

/** Spawn-time spec — SDK shape without the renderer-only `sessionId` field. */
export type AcpTerminalCreateSpec = Omit<CreateTerminalRequest, 'sessionId'>

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

  create(spec: AcpTerminalCreateSpec): Promise<CreateTerminalResponse>
  output(terminalId: string): Promise<TerminalOutputResponse>
  waitForExit(terminalId: string): Promise<WaitForTerminalExitResponse>
  kill(terminalId: string): Promise<void>
  release(terminalId: string): Promise<void>
}

export const IAcpTerminalService = createDecorator<IAcpTerminalService>('acpTerminalService')
