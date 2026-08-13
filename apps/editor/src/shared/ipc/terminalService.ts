/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-export barrel: the integrated-terminal wire contract now lives in
 *  @universe-editor/platform (`src/terminal/terminalProtocol.ts`) so both the
 *  local editor main and the remote server implement the same interface. Kept
 *  here so existing renderer/main import sites stay stable.
 *--------------------------------------------------------------------------------------------*/

export {
  ITerminalService,
  type ITerminalSpawnSpec,
  type ITerminalDataEvent,
  type ITerminalProfileConfigValue,
  type ITerminalProfile,
  type ITerminalProfilesRequest,
  type ITerminalExitEvent,
  type ITerminalTitleEvent,
  type ITerminalCreatedInfo,
} from '@universe-editor/platform'
