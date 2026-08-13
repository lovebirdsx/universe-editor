/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-export barrel: the diagnostic-stream decoder lives in node-services so the
 *  remote server and apps/editor main share one implementation. Kept here so the
 *  existing main-process import sites (`../process/decode.js`) stay stable.
 *--------------------------------------------------------------------------------------------*/

export { decodeDiagnostic } from '@universe-editor/node-services'
