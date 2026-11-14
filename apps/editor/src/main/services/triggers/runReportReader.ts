/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Local entry point for run report reads. The implementation lives in
 *  @universe-editor/node-services (`src/triggers/sessionReportReader.ts`) so the
 *  remote server enforces the same UUID / realpath / symlink / size guards; this
 *  module keeps the historical import path.
 *--------------------------------------------------------------------------------------------*/

export {
  DEFAULT_SESSION_REPORT_MAX_BYTES,
  SESSION_REPORT_FILE_NAME,
  SessionReportReader,
  type SessionReportReadResult,
  type SessionReportReaderOptions,
} from '@universe-editor/node-services'
