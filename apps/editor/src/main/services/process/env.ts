/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-export barrel: the shared child-env assembly lives in node-services so the
 *  remote server and apps/editor main share one implementation. Kept here so the
 *  existing main-process import sites (`../process/env.js`) stay stable.
 *--------------------------------------------------------------------------------------------*/

export {
  CHILD_ENV_DENYLIST,
  buildChildEnv,
  type BuildChildEnvOptions,
} from '@universe-editor/node-services'
