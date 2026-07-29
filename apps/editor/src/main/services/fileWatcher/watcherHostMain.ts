/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Entry point of the watcher utility process (its own electron-vite main
 *  input, forked via `utilityProcess.fork` by watcherUtilityTransport). Bridges
 *  `process.parentPort` to the transport-agnostic WatcherHost.
 *--------------------------------------------------------------------------------------------*/

import { WatcherHost } from './watcherHost.js'
import type { WatcherHostRequest } from './watcherProtocol.js'

// `process.parentPort` only exists inside an Electron utility process.
const parentPort = (
  process as unknown as {
    parentPort: {
      postMessage(message: unknown): void
      on(event: 'message', listener: (e: { data: unknown }) => void): void
    }
  }
).parentPort

const host = new WatcherHost((msg) => parentPort.postMessage(msg))

parentPort.on('message', (e) => {
  void host.handle(e.data as WatcherHostRequest)
})
