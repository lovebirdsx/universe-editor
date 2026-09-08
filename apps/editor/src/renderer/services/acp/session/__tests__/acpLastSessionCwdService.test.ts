/*---------------------------------------------------------------------------------------------
 *  Tests for acpLastSessionCwdService.ts — the persisted "last session cwd"
 *  memory that seeds the default directory of the next created session.
 *
 *  Two layers are covered:
 *    1. The service itself: remember/clear, debounced background staleness
 *       probe, serialization shape, workspace-swap bucket switch.
 *    2. The AcpSessionService wiring: an explicit cwd is remembered, a plain
 *       createSession reuses it, and authority-mismatch / foreign memories are
 *       silently ignored.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  NoopTelemetryService,
  NullLogger,
  REMOTE_SCHEME,
  StorageScope,
  URI,
  UriIdentityService,
} from '@universe-editor/platform'
import type {
  ILogger,
  ILoggerService,
  IStorageService,
  IWorkspace,
  IWorkspaceService,
  LogLevel,
} from '@universe-editor/platform'
import {
  AcpLastSessionCwdService,
  IAcpLastSessionCwdService,
  rememberedCwdForWindow,
} from '../acpLastSessionCwdService.js'

const URI_IDENTITY = new UriIdentityService('linux')

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return 1 as LogLevel
  }
}

/**
 * Workspace-swap capable storage: `store` is the currently active bucket.
 * `fireWorkspaceSwap(newBucket)` mirrors the real storage layer — the old
 * bucket keeps whatever was flushed into it, reads now hit the new bucket.
 */
class SwapStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  store = new Map<string, unknown>()
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  fireWorkspaceSwap(newBucket: Map<string, unknown>): void {
    this.store = newBucket
    this._onDidChangeWorkspaceScope.fire()
  }
  async get<T = unknown>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  current: IWorkspace | null = null
  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event
  readonly recent: readonly never[] = []
  private readonly _onDidChangeRecent = new Emitter<readonly never[]>()
  readonly onDidChangeRecent = this._onDidChangeRecent.event
  readonly whenReady: Promise<void> = Promise.resolve()
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

function makeService(opts: {
  storage?: IStorageService
  workspace?: IWorkspaceService
  exists?: (uri: URI) => boolean | Promise<boolean>
}): AcpLastSessionCwdService {
  const fileService = {
    _serviceBrand: undefined,
    exists: (uri: URI) => Promise.resolve(opts.exists?.(uri) ?? true),
  }
  return new AcpLastSessionCwdService(
    opts.storage ?? new SwapStorage(),
    opts.workspace ?? new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
    fileService as never,
  )
}

describe('AcpLastSessionCwdService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('remembers the last cwd and clear() drops it', () => {
    const svc = makeService({})
    expect(svc.lastCwd()).toBeUndefined()
    svc.remember('/ws/src', undefined)
    expect(svc.lastCwd()).toEqual({ cwd: '/ws/src' })
    svc.remember('/ws/other', undefined)
    expect(svc.lastCwd()).toEqual({ cwd: '/ws/other' })
    svc.clear()
    expect(svc.lastCwd()).toBeUndefined()
    svc.dispose()
  })

  it('keeps the authority alongside the cwd', () => {
    const svc = makeService({})
    svc.remember('/ws/src', 'ssh-remote+box')
    expect(svc.lastCwd()).toEqual({ cwd: '/ws/src', authority: 'ssh-remote+box' })
    svc.dispose()
  })

  it('persists through storage (debounced write) and reloads the shape', async () => {
    const storage = new SwapStorage()
    const svc = makeService({ storage })
    svc.remember('/ws/src', undefined)
    await vi.advanceTimersByTimeAsync(150)
    expect(storage.store.get('acp.lastSessionCwd')).toEqual({
      schemaVersion: 1,
      cwd: '/ws/src',
    })

    const restored = makeService({ storage })
    const loaded = restored.initialize()
    // Cold start with no workspace waits for the initial-load timeout.
    await vi.advanceTimersByTimeAsync(600)
    await loaded
    expect(restored.lastCwd()).toEqual({ cwd: '/ws/src' })
    svc.dispose()
    restored.dispose()
  })

  it('ignores payloads with an unknown schemaVersion', async () => {
    const storage = new SwapStorage()
    storage.store.set('acp.lastSessionCwd', { schemaVersion: 99, cwd: '/ws/src' })
    const svc = makeService({ storage })
    const loaded = svc.initialize()
    await vi.advanceTimersByTimeAsync(600)
    await loaded
    expect(svc.lastCwd()).toBeUndefined()
    svc.dispose()
  })

  it('ignores malformed payloads', async () => {
    const storage = new SwapStorage()
    storage.store.set('acp.lastSessionCwd', { schemaVersion: 1, cwd: 42 })
    const svc = makeService({ storage })
    const loaded = svc.initialize()
    await vi.advanceTimersByTimeAsync(600)
    await loaded
    expect(svc.lastCwd()).toBeUndefined()
    svc.dispose()
  })

  it('background probe clears the memory when the directory is gone', async () => {
    const svc = makeService({ exists: () => false })
    svc.remember('/ws/gone', undefined)
    expect(svc.lastCwd()).toEqual({ cwd: '/ws/gone' })
    await vi.advanceTimersByTimeAsync(150)
    expect(svc.lastCwd()).toBeUndefined()
    svc.dispose()
  })

  it('background probe keeps the memory when exists() throws', async () => {
    // A probe *failure* (unreachable remote host, transport hiccup) is not
    // proof the directory is gone — only a clean `false` clears.
    const svc = makeService({
      exists: () => {
        throw new Error('host unreachable')
      },
    })
    svc.remember('/ws/gone', undefined)
    await vi.advanceTimersByTimeAsync(150)
    expect(svc.lastCwd()).toEqual({ cwd: '/ws/gone' })
    svc.dispose()
  })

  it('background probe keeps the memory when the directory exists', async () => {
    const svc = makeService({ exists: () => true })
    svc.remember('/ws/alive', undefined)
    await vi.advanceTimersByTimeAsync(150)
    expect(svc.lastCwd()).toEqual({ cwd: '/ws/alive' })
    svc.dispose()
  })

  it('probes remote directories through a remote-scheme URI', async () => {
    const seen: URI[] = []
    const svc = makeService({
      exists: (uri) => {
        seen.push(uri)
        return true
      },
    })
    svc.remember('/ws/src', 'ssh-remote+box')
    await vi.advanceTimersByTimeAsync(150)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.scheme).toBe(REMOTE_SCHEME)
    expect(seen[0]!.authority).toBe('ssh-remote+box')
    expect(seen[0]!.path).toBe('/ws/src')
    svc.dispose()
  })

  it('a stale probe result never clears a newer memory', async () => {
    // Two probes overlap: the first remember's probe is still in flight when
    // the second remember bumps the generation. The stale `false` landing
    // afterwards must not clear the newer memory.
    let resolveFirst!: (v: boolean) => void
    let calls = 0
    const svc = makeService({
      exists: () => {
        calls++
        if (calls === 1) {
          return new Promise<boolean>((res) => {
            resolveFirst = res
          })
        }
        return true
      },
    })
    svc.remember('/ws/first', undefined)
    await vi.advanceTimersByTimeAsync(150) // probe(1) fires and hangs in exists()
    svc.remember('/ws/second', undefined) // generation bump → probe(2) scheduled
    resolveFirst(false) // stale probe lands — must be ignored
    await vi.advanceTimersByTimeAsync(150)
    expect(svc.lastCwd()).toEqual({ cwd: '/ws/second' })
    svc.dispose()
  })

  it('workspace swap reloads from the new bucket', async () => {
    const storage = new SwapStorage()
    const bucketA = storage.store
    const workspace = new FakeWorkspaceService()
    workspace.current = { folder: URI.file('/ws/a'), name: 'a' }
    const svc = makeService({ storage, workspace })
    await svc.initialize()

    svc.remember('/ws/a/src', undefined)
    await vi.advanceTimersByTimeAsync(150)
    expect(bucketA.get('acp.lastSessionCwd')).toEqual({ schemaVersion: 1, cwd: '/ws/a/src' })

    // Switch to workspace B: the new bucket has its own memory.
    const bucketB = new Map<string, unknown>([
      ['acp.lastSessionCwd', { schemaVersion: 1, cwd: '/ws/b/lib' }],
    ])
    workspace.current = { folder: URI.file('/ws/b'), name: 'b' }
    storage.fireWorkspaceSwap(bucketB)
    await vi.waitFor(() => {
      expect(svc.lastCwd()).toEqual({ cwd: '/ws/b/lib' })
    })
    // Bucket A's memory must not leak into workspace B.
    expect(bucketA.get('acp.lastSessionCwd')).toEqual({ schemaVersion: 1, cwd: '/ws/a/src' })
    svc.dispose()
  })
})

// ---------------------------------------------------------------------------
// AcpSessionService wiring: default cwd resolution.
// These exercise the private `_rememberedCwd` gate through the public
// createSession surface with a stubbed IAcpLastSessionCwdService.
// ---------------------------------------------------------------------------

interface StubLastCwd extends IAcpLastSessionCwdService {
  remembered: { cwd: string; authority?: string } | undefined
  readonly rememberedCalls: Array<{ cwd: string; authority: string | undefined }>
}

function stubLastCwd(remembered: { cwd: string; authority?: string } | undefined): StubLastCwd {
  const calls: Array<{ cwd: string; authority: string | undefined }> = []
  return {
    _serviceBrand: undefined,
    remembered,
    rememberedCalls: calls,
    initialize: () => Promise.resolve(),
    lastCwd() {
      return this.remembered
    },
    remember(cwd: string, authority: string | undefined) {
      calls.push({ cwd, authority })
      this.remembered = authority !== undefined ? { cwd, authority } : { cwd }
    },
    clear() {
      this.remembered = undefined
    },
  }
}

function rememberedCwdGate(
  lastCwd: IAcpLastSessionCwdService,
  currentFolder: URI | undefined,
): string | undefined {
  if (!currentFolder) return undefined
  return rememberedCwdForWindow(lastCwd.lastCwd(), currentFolder, URI_IDENTITY)
}

describe('last-session-cwd default gate', () => {
  it('uses the remembered cwd when it is inside the workspace', () => {
    const lastCwd = stubLastCwd({ cwd: '/ws/src' })
    expect(rememberedCwdGate(lastCwd, URI.file('/ws'))).toBe('/ws/src')
  })

  it('accepts the workspace root itself', () => {
    const lastCwd = stubLastCwd({ cwd: '/ws' })
    expect(rememberedCwdGate(lastCwd, URI.file('/ws'))).toBe('/ws')
  })

  it('falls back when the memory points outside the workspace (foreign)', () => {
    const lastCwd = stubLastCwd({ cwd: '/elsewhere/src' })
    expect(rememberedCwdGate(lastCwd, URI.file('/ws'))).toBeUndefined()
  })

  it('falls back when the remembered authority differs from the window', () => {
    const lastCwd = stubLastCwd({ cwd: '/ws/src', authority: 'ssh-remote+box' })
    expect(rememberedCwdGate(lastCwd, URI.file('/ws'))).toBeUndefined()
  })

  it('falls back when a local window opens a remote memory', () => {
    const remoteFolder = URI.from({
      scheme: REMOTE_SCHEME,
      authority: 'ssh-remote+box',
      path: '/ws',
    })
    const lastCwd = stubLastCwd({ cwd: '/ws/src' })
    expect(rememberedCwdGate(lastCwd, remoteFolder)).toBeUndefined()
  })

  it('uses a remote memory when the window is on the same host', () => {
    const remoteFolder = URI.from({
      scheme: REMOTE_SCHEME,
      authority: 'ssh-remote+box',
      path: '/ws',
    })
    const lastCwd = stubLastCwd({ cwd: '/ws/src', authority: 'ssh-remote+box' })
    expect(rememberedCwdGate(lastCwd, remoteFolder)).toBe('/ws/src')
  })

  it('remember() records every createSession cwd (last-wins)', () => {
    const lastCwd = stubLastCwd(undefined)
    lastCwd.remember('/ws/src', undefined)
    lastCwd.remember('/ws/lib', undefined)
    expect(lastCwd.rememberedCalls).toEqual([
      { cwd: '/ws/src', authority: undefined },
      { cwd: '/ws/lib', authority: undefined },
    ])
    expect(lastCwd.lastCwd()).toEqual({ cwd: '/ws/lib' })
  })
})
