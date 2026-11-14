/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Local entry point for poll command execution. The implementation lives in
 *  @universe-editor/node-services (`src/triggers/pollCommandFetcher.ts`) so a
 *  remote workspace runs the exact same timeout / 1 MB cap / process-tree-kill
 *  semantics on the remote host; this module keeps the historical import path.
 *--------------------------------------------------------------------------------------------*/

export {
  POLL_MAX_PAYLOAD_VALUE_LENGTH,
  POLL_MAX_STDOUT_BYTES,
  createPollCommandFetcher,
  describePollExecError,
  killPollProcessTree as killProcessTree,
  parsePollStdout,
  toPayloadValue,
  type PollCommandFetcher,
  type PollFetchRequest,
  type PollFetchResult,
  type PollItem,
} from '@universe-editor/node-services'
