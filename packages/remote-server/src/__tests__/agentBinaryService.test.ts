/*---------------------------------------------------------------------------------------------
 *  Tests for packages/remote-server/src/agentBinaryService.ts
 *  Pure logic only: the store itself is covered in node-services, so these tests
 *  inject a fake store factory and exercise throttling, lazy construction /
 *  agent dispatch, and baseDir composition.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Emitter, type IDisposable, type ILoggerService } from '@universe-editor/platform'
import {
  type AgentBinaryDownloadState,
  type AgentBinaryId,
  type AgentBinaryRemoteDownloadEvent,
  type AgentBinaryStore,
  type AgentBinaryVersionInfo,
} from '@universe-editor/node-services'
import { RemoteAgentBinaryService } from '../agentBinaryService.js'

class FakeStore implements IDisposable {
  private readonly _onDownload = new Emitter<readonly AgentBinaryDownloadState[]>()
  readonly onDidChangeDownload = this._onDownload.event
  readonly resolves: boolean[] = []
  versionInfoCalls: number = 0
  readonly forceDownloads: string[] = []
  prefetchCalls: number = 0
  cleanupCalls: number = 0

  constructor(
    readonly agent: AgentBinaryId,
    readonly baseDir: string,
  ) {}

  async resolveDownload(allowDownload: boolean): Promise<string> {
    this.resolves.push(allowDownload)
    return `/fake/${this.agent}`
  }

  async getVersionInfo(): Promise<AgentBinaryVersionInfo> {
    this.versionInfoCalls++
    return {
      bundledVersion: `bundled-${this.agent}`,
      installedVersion: null,
      latestVersion: null,
      downloadedVersions: [],
      downloads: [],
    }
  }

  async forceDownload(version: string): Promise<string> {
    this.forceDownloads.push(version)
    return `/fake/${this.agent}/${version}`
  }

  async prefetch(): Promise<void> {
    this.prefetchCalls++
  }

  async cleanupStaleVersions(): Promise<void> {
    this.cleanupCalls++
  }

  fireDownload(downloads: readonly AgentBinaryDownloadState[]): void {
    this._onDownload.fire(downloads)
  }

  dispose(): void {
    this._onDownload.dispose()
  }
}

function state(received: number, total: number, version = '1.0.0'): AgentBinaryDownloadState {
  return { version, received, total, background: false }
}

function makeService(
  built: { agent: AgentBinaryId; baseDir: string }[],
  stores: Map<AgentBinaryId, FakeStore>,
): RemoteAgentBinaryService {
  return new RemoteAgentBinaryService({
    agentBinaryDir: '/data/agent-bin',
    loggerService: {} as ILoggerService,
    createStore: (agent, baseDir) => {
      built.push({ agent, baseDir })
      const store = new FakeStore(agent, baseDir)
      stores.set(agent, store)
      return store as unknown as AgentBinaryStore
    },
  })
}

describe('RemoteAgentBinaryService', () => {
  it('constructs both stores lazily under agentBinaryDir/<agent> and dispatches by agent', async () => {
    const built: { agent: AgentBinaryId; baseDir: string }[] = []
    const stores = new Map<AgentBinaryId, FakeStore>()
    const svc = makeService(built, stores)
    try {
      expect(built).toHaveLength(0)

      await expect(svc.resolve('claude', {})).resolves.toEqual({ path: '/fake/claude' })
      expect(built).toEqual([{ agent: 'claude', baseDir: path.join('/data/agent-bin', 'claude') }])
      expect(stores.get('claude')!.resolves).toEqual([true])

      await expect(svc.resolve('codex', { allowDownload: false })).resolves.toEqual({
        path: '/fake/codex',
      })
      expect(built).toEqual([
        { agent: 'claude', baseDir: path.join('/data/agent-bin', 'claude') },
        { agent: 'codex', baseDir: path.join('/data/agent-bin', 'codex') },
      ])
      expect(stores.get('codex')!.resolves).toEqual([false])

      // Re-resolving an agent reuses its cached store (no rebuild).
      await svc.resolve('claude', {})
      expect(built).toHaveLength(2)
    } finally {
      svc.dispose()
    }
  })

  it('throttles intermediate progress but never drops a begin, a 100% frame or the end', () => {
    let now = 0
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const built: { agent: AgentBinaryId; baseDir: string }[] = []
      const stores = new Map<AgentBinaryId, FakeStore>()
      const svc = makeService(built, stores)
      const events: AgentBinaryRemoteDownloadEvent[] = []
      const sub = svc.onDidChangeDownload((e) => events.push(e))
      try {
        // Force construction of the claude store (and its subscription).
        void svc.resolve('claude', {})
        const claude = stores.get('claude')!

        claude.fireDownload([state(0, 100)]) // set grew from empty → always fires
        now = 50
        claude.fireDownload([state(2, 100)]) // same shape, within window → dropped
        now = 100
        claude.fireDownload([state(3, 100)]) // >=100ms later → fires
        now = 101
        claude.fireDownload([state(100, 100)]) // 100% → always fires
        now = 102
        claude.fireDownload([]) // set emptied → always fires, or the UI sticks

        expect(events).toEqual([
          { agent: 'claude', downloads: [state(0, 100)] },
          { agent: 'claude', downloads: [state(3, 100)] },
          { agent: 'claude', downloads: [state(100, 100)] },
          { agent: 'claude', downloads: [] },
        ])
      } finally {
        sub.dispose()
        svc.dispose()
      }
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('forwards a version joining or leaving the in-flight set immediately', () => {
    const now = 0
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const built: { agent: AgentBinaryId; baseDir: string }[] = []
      const stores = new Map<AgentBinaryId, FakeStore>()
      const svc = makeService(built, stores)
      const events: AgentBinaryRemoteDownloadEvent[] = []
      const sub = svc.onDidChangeDownload((e) => events.push(e))
      try {
        void svc.resolve('claude', {})
        const claude = stores.get('claude')!

        // A second, concurrent download (background prefetch + a user click) must
        // surface even though it lands inside the throttle window.
        claude.fireDownload([state(1, 100, '1.0.0')])
        claude.fireDownload([state(1, 100, '1.0.0'), state(0, 100, '2.0.0')])
        claude.fireDownload([state(2, 100, '2.0.0')])

        expect(events).toEqual([
          { agent: 'claude', downloads: [state(1, 100, '1.0.0')] },
          {
            agent: 'claude',
            downloads: [state(1, 100, '1.0.0'), state(0, 100, '2.0.0')],
          },
          { agent: 'claude', downloads: [state(2, 100, '2.0.0')] },
        ])
      } finally {
        sub.dispose()
        svc.dispose()
      }
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('keeps throttle state independent across agents', () => {
    const now = 0
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const built: { agent: AgentBinaryId; baseDir: string }[] = []
      const stores = new Map<AgentBinaryId, FakeStore>()
      const svc = makeService(built, stores)
      const events: AgentBinaryRemoteDownloadEvent[] = []
      const sub = svc.onDidChangeDownload((e) => events.push(e))
      try {
        void svc.resolve('claude', {})
        void svc.resolve('codex', {})
        const claude = stores.get('claude')!
        const codex = stores.get('codex')!

        claude.fireDownload([state(1, 100)])
        // Same timestamp, different agent — codex has its own throttle state.
        codex.fireDownload([state(1, 100)])

        expect(events).toEqual([
          { agent: 'claude', downloads: [state(1, 100)] },
          { agent: 'codex', downloads: [state(1, 100)] },
        ])
      } finally {
        sub.dispose()
        svc.dispose()
      }
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('getVersionInfo delegates to the per-agent store and passes the value through', async () => {
    const built: { agent: AgentBinaryId; baseDir: string }[] = []
    const stores = new Map<AgentBinaryId, FakeStore>()
    const svc = makeService(built, stores)
    try {
      await expect(svc.getVersionInfo('codex')).resolves.toEqual({
        bundledVersion: 'bundled-codex',
        installedVersion: null,
        latestVersion: null,
        downloadedVersions: [],
        downloads: [],
      })
      expect(stores.get('codex')!.versionInfoCalls).toBe(1)
      expect(stores.get('claude')).toBeUndefined()
    } finally {
      svc.dispose()
    }
  })

  it('forceDownload delegates the version to the per-agent store and wraps the path', async () => {
    const built: { agent: AgentBinaryId; baseDir: string }[] = []
    const stores = new Map<AgentBinaryId, FakeStore>()
    const svc = makeService(built, stores)
    try {
      await expect(svc.forceDownload('claude', '1.2.3')).resolves.toEqual({
        path: '/fake/claude/1.2.3',
      })
      expect(stores.get('claude')!.forceDownloads).toEqual(['1.2.3'])
    } finally {
      svc.dispose()
    }
  })

  it('prefetch delegates to the per-agent store without touching the other agent', async () => {
    const built: { agent: AgentBinaryId; baseDir: string }[] = []
    const stores = new Map<AgentBinaryId, FakeStore>()
    const svc = makeService(built, stores)
    try {
      await svc.prefetch('claude')
      expect(stores.get('claude')!.prefetchCalls).toBe(1)
      expect(stores.get('codex')).toBeUndefined()
    } finally {
      svc.dispose()
    }
  })

  it('cleanupStaleVersions delegates to the per-agent store without touching the other agent', async () => {
    const built: { agent: AgentBinaryId; baseDir: string }[] = []
    const stores = new Map<AgentBinaryId, FakeStore>()
    const svc = makeService(built, stores)
    try {
      await svc.cleanupStaleVersions('codex')
      expect(stores.get('codex')!.cleanupCalls).toBe(1)
      expect(stores.get('claude')).toBeUndefined()
    } finally {
      svc.dispose()
    }
  })
})
