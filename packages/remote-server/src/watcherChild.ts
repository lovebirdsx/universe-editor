/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Watcher child process entry: runs the parcel-native WatcherHost in its own
 *  process so a native crash (@parcel/watcher backend) kills this process, not
 *  the daemon. The parent (server.ts) forks this file and pumps the watcher
 *  message protocol over the child_process IPC channel; WatcherProcessClient on
 *  the parent side restarts it and replays subscriptions after a crash.
 *--------------------------------------------------------------------------------------------*/

import { WatcherHost } from '@universe-editor/node-services'
import type { WatcherHostRequest, WatcherHostResponse } from '@universe-editor/platform'

const host = new WatcherHost((msg: WatcherHostResponse) => {
  process.send?.(msg)
})

process.on('message', (msg: WatcherHostRequest) => {
  void host.handle(msg)
})

let shuttingDown = false

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await host.dispose()
  } catch {
    // best-effort teardown
  }
  process.exit(0)
}

// The parent closes our stdin when it exits; self-terminate so an orphaned
// daemon crash never leaves a live watcher holding native handles.
process.stdin.resume()
process.stdin.on('end', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
