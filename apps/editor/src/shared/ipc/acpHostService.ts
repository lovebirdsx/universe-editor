/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-export barrel: the ACP process-host wire contract now lives in
 *  @universe-editor/platform (`src/acp/acpHostProtocol.ts`) so the local editor
 *  main, the renderer and a remote server implement the same interface. Kept
 *  here so existing renderer/main import sites stay stable.
 *--------------------------------------------------------------------------------------------*/

export {
  IAcpHostService,
  type AcpLaunchSpec,
  type AcpStdioChunk,
  type AcpExitEvent,
  type AcpStartResult,
} from '@universe-editor/platform'
