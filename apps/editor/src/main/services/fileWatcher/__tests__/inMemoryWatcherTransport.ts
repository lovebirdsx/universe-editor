/*---------------------------------------------------------------------------------------------
 *  In-process IWatcherTransport for tests: a real WatcherHost (real parcel
 *  native watcher) behind the real message protocol, minus the utility
 *  process. Lets the FileWatcherMainService integration suite exercise the
 *  full client → protocol → host → parcel chain in one node process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import { WatcherHost } from '../watcherHost.js'
import type { IWatcherTransport } from '../watcherProcessClient.js'
import type { WatcherHostRequest, WatcherHostResponse } from '../watcherProtocol.js'

export interface InMemoryWatcherTransport extends IWatcherTransport {
  readonly host: WatcherHost
  /** Kill the host (real parcel unsubscribes) and fire exit, like a native crash would. */
  simulateCrash(code?: number): void
}

export function createInMemoryWatcherTransport(): InMemoryWatcherTransport {
  const onMessage = new Emitter<WatcherHostResponse>()
  const onExit = new Emitter<number | undefined>()
  const host = new WatcherHost((msg) => onMessage.fire(msg))
  return {
    host,
    post: (msg: WatcherHostRequest) => void host.handle(msg),
    onMessage: onMessage.event,
    onExit: onExit.event,
    kill: () => void host.dispose(),
    simulateCrash: (code = 1) => {
      void host.dispose()
      onExit.fire(code)
    },
  }
}
