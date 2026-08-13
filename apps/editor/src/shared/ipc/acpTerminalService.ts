/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-export barrel: the ACP terminal-pool wire contract now lives in
 *  @universe-editor/platform (`src/acp/acpTerminalProtocol.ts`) so the local
 *  editor main and a remote server implement the same interface. Kept here so
 *  existing renderer/main import sites stay stable.
 *--------------------------------------------------------------------------------------------*/

export {
  IAcpTerminalService,
  type AcpTerminalCreateSpec,
  type AcpTerminalCreatedInfo,
  type AcpTerminalEnvVariable,
  type AcpTerminalExitStatus,
  type AcpTerminalOutput,
  type AcpTerminalWaitExit,
} from '@universe-editor/platform'
