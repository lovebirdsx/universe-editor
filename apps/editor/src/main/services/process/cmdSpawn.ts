/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-export barrel: the cmd.exe spawn wrapper lives in node-services so the
 *  remote server and apps/editor main share one implementation. Kept here so the
 *  existing main-process import sites (`../process/cmdSpawn.js`) stay stable.
 *--------------------------------------------------------------------------------------------*/

export {
  buildCmdCommandLine,
  quoteCmdArg,
  spawnViaCmd,
  type CmdSpawnOptions,
} from '@universe-editor/node-services'
