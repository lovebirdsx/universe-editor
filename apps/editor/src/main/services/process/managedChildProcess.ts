/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Electron-coupled wrapper over the shared ManagedChildProcess: binds the
 *  update-restart shutdown trace marks into the synchronous kill path. The
 *  lifecycle wrapper itself lives in @universe-editor/node-services.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  ManagedChildProcess as NodeManagedChildProcess,
  type ManagedChildOptions,
} from '@universe-editor/node-services'
import { recordShutdownMark } from '../update/updateShutdownTrace.js'

export class ManagedChildProcess extends NodeManagedChildProcess {
  constructor(child: ChildProcessWithoutNullStreams, options: ManagedChildOptions = {}) {
    super(child, { ...options, shutdownMark: recordShutdownMark })
  }
}

export {
  CHILD_PROCESS_EXITED_CODE,
  CHILD_STDIN_NOT_WRITABLE_CODE,
  DEFAULT_KILL_TIMEOUT_MS,
  type ChildProcessError,
  type ManagedChildOptions,
  type ManagedExit,
  type TreeKiller,
} from '@universe-editor/node-services'
