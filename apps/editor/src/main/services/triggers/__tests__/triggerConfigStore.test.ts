/*---------------------------------------------------------------------------------------------
 *  Tests for RemoteTriggerConfigStore: every remote I/O is gated on the connection
 *  state, the tunnelled watcher drives the debounced reload, and disposal never
 *  talks to the host after a disconnect.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  URI,
  type IFileService,
  type ILogger,
  type WatcherHostRequest,
  type WatcherHostResponse,
} from '@universe-editor/platform'
import { WatcherProcessClient, type IWatcherTransport } from '@universe-editor/node-services'
import type { TriggersConfig } from '../../../../shared/triggers/types.js'
import type {
  IRemoteConnectionService,
  RemoteConnectionState,
} from '../../remote/remoteConnectionMainService.js'
import { remotePathFromUri } from '../../remote/remoteUri.js'
import {
  RemoteTriggerConfigStore,
  type RemoteTriggerConfigStoreOptions,
} from '../triggerConfigStore.js'
import { workspaceTriggersConfigDirUri, workspaceTriggersConfigUri } from '../triggersConfigFile.js'

const AUTHORITY = 'dev'
const WORKSPACE = URI.from({
  scheme: 'remote-ssh',
  authority: AUTHORITY,
  path: '/home/testuser/proj',
})
const CONFIG_URI = workspaceTriggersConfigUri(WORKSPACE)
const DIR_URI = workspaceTriggersConfigDirUri(WORKSPACE)

const BUDGET = { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 1440 }

function configText(id: string): string {
  const config: TriggersConfig = {
    version: 1,
    triggers: [
      {
        id,
        name: id,
        enabled: true,
        showSession: false,
        source: { type: 'manual' },
        session: { prompt: 'Do it', budget: BUDGET },
        allowedActions: [],
        concurrency: 1,
        overflow: 'queue',
      },
    ],
    invalid: [],
  }
  return JSON.stringify(config, null, 2)
}

function createLogger(): ILogger {
  return {
    level: 0,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
    setLevel: () => undefined,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    flush: () => undefined,
  } as unknown as ILogger
}

class FakeFileService {
  readonly files = new Map<string, string>()
  readonly directories = new Set<string>()
  readonly reads: string[] = []
  writes = 0

  async readFileText(uri: URI): Promise<string> {
    this.reads.push(uri.toString())
    const text = this.files.get(uri.toString())
    if (text === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    return text
  }

  async exists(uri: URI): Promise<boolean> {
    return this.files.has(uri.toString()) || this.directories.has(uri.toString())
  }

  async writeFile(uri: URI, content: Uint8Array | string): Promise<void> {
    this.writes++
    this.files.set(uri.toString(), typeof content === 'string' ? content : String(content))
  }

  async createDirectory(uri: URI): Promise<void> {
    this.directories.add(uri.toString())
  }
}

class FakeConnections {
  state: RemoteConnectionState | undefined = 'connected'
  private readonly _onDidChangeState = new Emitter<{
    authority: string
    state: RemoteConnectionState
  }>()
  readonly onDidChangeState = this._onDidChangeState.event
  readonly getState = (_authority: string): RemoteConnectionState | undefined => this.state
  readonly getConnection = vi.fn(async () => {
    throw new Error('no connection needed in store tests')
  })
}

class FakeTransport implements IWatcherTransport {
  readonly posts: WatcherHostRequest[] = []
  readonly watched = new Map<number, string>()
  private readonly _onMessage = new Emitter<WatcherHostResponse>()
  readonly onMessage = this._onMessage.event
  private readonly _onExit = new Emitter<number | undefined>()
  readonly onExit = this._onExit.event

  post(msg: WatcherHostRequest): void {
    this.posts.push(msg)
    if (msg.kind === 'subscribe') this.watched.set(msg.id, msg.dir)
    else this.watched.delete(msg.id)
    queueMicrotask(() => this._onMessage.fire({ kind: 'ack', seq: msg.seq }))
  }

  emit(events: readonly { path: string; type: 'create' | 'update' | 'delete' }[]): void {
    for (const id of this.watched.keys()) {
      this._onMessage.fire({ kind: 'events', id, events })
    }
  }

  kill(): void {}
}

interface Harness {
  readonly store: RemoteTriggerConfigStore
  readonly files: FakeFileService
  readonly connections: FakeConnections
  readonly transport: FakeTransport
  readonly transports: () => number
}

function createStore(options: Partial<RemoteTriggerConfigStoreOptions> = {}): Harness {
  const files = new FakeFileService()
  const connections = new FakeConnections()
  const transport = new FakeTransport()
  let transports = 0
  const store = new RemoteTriggerConfigStore({
    workspaceUri: WORKSPACE,
    logger: createLogger(),
    fileService: files as unknown as IFileService,
    connections: connections as unknown as IRemoteConnectionService,
    debounceMs: 1,
    createWatcherClient: () => {
      transports++
      return new WatcherProcessClient(() => transport)
    },
    ...options,
  })
  return { store, files, connections, transport, transports: () => transports }
}

const stores: RemoteTriggerConfigStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
})

describe('RemoteTriggerConfigStore', () => {
  it('loads the config through IFileService and watches .universe-editor', async () => {
    const harness = createStore()
    stores.push(harness.store)
    harness.files.files.set(CONFIG_URI.toString(), configText('remote-a'))
    harness.files.directories.add(DIR_URI.toString())

    const state = await harness.store.load()

    expect(state.error).toBeUndefined()
    expect(state.value.triggers.map((trigger) => trigger.id)).toEqual(['remote-a'])
    expect(harness.files.reads).toEqual([CONFIG_URI.toString()])
    await vi.waitFor(() => expect(harness.transport.watched.size).toBe(1))
    expect([...harness.transport.watched.values()]).toEqual([remotePathFromUri(DIR_URI)])
  })

  it('falls back to the workspace root while .universe-editor is missing', async () => {
    const harness = createStore()
    stores.push(harness.store)
    harness.files.files.set(CONFIG_URI.toString(), configText('remote-a'))

    await harness.store.load()
    await vi.waitFor(() => expect(harness.transport.watched.size).toBe(1))

    expect([...harness.transport.watched.values()]).toEqual([remotePathFromUri(WORKSPACE)])
  })

  it('performs no remote I/O while the connection is not connected', async () => {
    const harness = createStore()
    stores.push(harness.store)
    harness.connections.state = 'reconnecting'
    harness.files.files.set(CONFIG_URI.toString(), configText('remote-a'))

    const state = await harness.store.load()

    expect(state.value.triggers).toEqual([])
    expect(harness.files.reads).toEqual([])
    expect(harness.transports()).toBe(0)
  })

  it('reloads after a debounced watcher event and keeps the last valid config', async () => {
    const harness = createStore()
    stores.push(harness.store)
    harness.files.files.set(CONFIG_URI.toString(), configText('remote-a'))
    await harness.store.load()
    await vi.waitFor(() => expect(harness.transport.watched.size).toBe(1))

    const changes: TriggersConfig[] = []
    harness.store.onDidChangeExternal((state) => changes.push(state.value))

    harness.files.files.set(CONFIG_URI.toString(), configText('remote-b'))
    harness.transport.emit([{ path: remotePathFromUri(CONFIG_URI), type: 'update' }])
    await vi.waitFor(() =>
      expect(harness.store.state.value.triggers.map((t) => t.id)).toEqual(['remote-b']),
    )
    expect(changes.at(-1)?.triggers.map((t) => t.id)).toEqual(['remote-b'])

    harness.files.files.set(CONFIG_URI.toString(), '{ not json')
    harness.transport.emit([{ path: remotePathFromUri(CONFIG_URI), type: 'update' }])
    await vi.waitFor(() => expect(harness.store.state.error).toBeDefined())
    expect(harness.store.state.value.triggers.map((t) => t.id)).toEqual(['remote-b'])
    expect(changes.at(-1)?.triggers.map((t) => t.id)).toEqual(['remote-b'])
  })

  it('does not unsubscribe over the tunnel when disposed after a disconnect', async () => {
    const harness = createStore()
    harness.files.files.set(CONFIG_URI.toString(), configText('remote-a'))
    await harness.store.load()
    await vi.waitFor(() => expect(harness.transport.watched.size).toBe(1))

    harness.connections.state = 'reconnecting'
    harness.store.dispose()

    expect(harness.transport.posts.some((msg) => msg.kind === 'unsubscribe')).toBe(false)
  })

  it('unsubscribes while still connected', async () => {
    const harness = createStore()
    harness.files.files.set(CONFIG_URI.toString(), configText('remote-a'))
    await harness.store.load()
    await vi.waitFor(() => expect(harness.transport.watched.size).toBe(1))

    harness.store.dispose()

    await vi.waitFor(() =>
      expect(harness.transport.posts.some((msg) => msg.kind === 'unsubscribe')).toBe(true),
    )
  })
})
