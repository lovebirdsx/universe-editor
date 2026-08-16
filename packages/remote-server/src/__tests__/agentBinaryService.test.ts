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
  type AgentBinaryId,
  type AgentBinaryProgressEvent,
  type AgentBinaryRemoteProgressEvent,
  type AgentBinaryStore,
  type AgentBinaryVersionInfo,
} from '@universe-editor/node-services'
import { RemoteAgentBinaryService } from '../agentBinaryService.js'

class FakeStore implements IDisposable {
  private readonly _onProgress = new Emitter<AgentBinaryProgressEvent>()
  readonly onDidChangeProgress = this._onProgress.event
  readonly resolves: boolean[] = []
  versionInfoCalls: number = 0
  readonly forceDownloads: string[] = []

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
      prefetchedVersion: null,
    }
  }

  async forceDownload(version: string): Promise<string> {
    this.forceDownloads.push(version)
    return `/fake/${this.agent}/${version}`
  }

  fireProgress(p: AgentBinaryProgressEvent): void {
    this._onProgress.fire(p)
  }

  dispose(): void {
    this._onProgress.dispose()
  }
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

  it('throttles progress per agent (>=100ms interval, or 100% always fires)', () => {
    let now = 0
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const built: { agent: AgentBinaryId; baseDir: string }[] = []
      const stores = new Map<AgentBinaryId, FakeStore>()
      const svc = makeService(built, stores)
      const events: AgentBinaryRemoteProgressEvent[] = []
      const sub = svc.onDidChangeProgress((e) => events.push(e))
      try {
        // Force construction of the claude store (and its subscription).
        void svc.resolve('claude', {})
        const claude = stores.get('claude')!

        claude.fireProgress({ received: 1, total: 100 }) // first event always fires
        now = 50
        claude.fireProgress({ received: 2, total: 100 }) // within window → dropped
        now = 100
        claude.fireProgress({ received: 3, total: 100 }) // >=100ms later → fires
        now = 101
        claude.fireProgress({ received: 100, total: 100 }) // 100% → always fires

        expect(events).toEqual([
          { agent: 'claude', received: 1, total: 100 },
          { agent: 'claude', received: 3, total: 100 },
          { agent: 'claude', received: 100, total: 100 },
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
      const events: AgentBinaryRemoteProgressEvent[] = []
      const sub = svc.onDidChangeProgress((e) => events.push(e))
      try {
        void svc.resolve('claude', {})
        void svc.resolve('codex', {})
        const claude = stores.get('claude')!
        const codex = stores.get('codex')!

        claude.fireProgress({ received: 1, total: 100 })
        // Same timestamp, different agent — codex has its own throttle state.
        codex.fireProgress({ received: 1, total: 100 })

        expect(events).toEqual([
          { agent: 'claude', received: 1, total: 100 },
          { agent: 'codex', received: 1, total: 100 },
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
        prefetchedVersion: null,
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
})
