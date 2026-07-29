/*---------------------------------------------------------------------------------------------
 *  Minimal WatcherProcessClient stub for tests that never actually watch:
 *  ids allocate, subscriptions are accepted and dropped, no events ever fire.
 *--------------------------------------------------------------------------------------------*/

import type { WatcherProcessClient } from '../watcherProcessClient.js'

export function createStubWatcherProcessClient(): WatcherProcessClient {
  let nextId = 1
  const noopDisposable = { dispose: () => {} }
  return {
    allocateId: () => nextId++,
    onFileEvents: () => noopDisposable,
    onWatchError: () => noopDisposable,
    onDidRestart: () => noopDisposable,
    watch: () => Promise.resolve(),
    unwatch: () => Promise.resolve(),
    dispose: () => {},
  } as unknown as WatcherProcessClient
}
