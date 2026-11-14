/*---------------------------------------------------------------------------------------------
 *  Tests for the remote triggerPoll channel (src/triggerService.ts + server.ts
 *  registration). Drive a full server over an in-memory protocol pair, exactly
 *  like server.test.ts, and additionally exercise the remote-ssh <-> file URI
 *  translation the daemon applies on the server side of the tunnel.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ChannelPair,
  InMemoryMessagePassingProtocol,
  ProxyChannel,
  URI,
  createBinaryCodec,
  createRemoteURITransformer,
  RemoteChannels,
} from '@universe-editor/platform'
import type { IRemoteTriggerService } from '@universe-editor/node-services'
import { mkTempDir } from '@universe-editor/temp-root'
import { createRemoteServer } from '../server.js'

const AUTHORITY = 'testhost'
const CLIENT_ID = 'testuser-install-1'
const OTHER_CLIENT_ID = 'testuser-install-2'
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_RUN_ID = '223e4567-e89b-42d3-a456-426614174000'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = mkTempDir('ue-remote-triggers-')
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

function connect(options: { dataDir?: string; translateUris?: boolean; jsonCodec?: boolean }): {
  triggers: IRemoteTriggerService
  dispose: () => void
} {
  const [a, b] = InMemoryMessagePassingProtocol.createPair()
  // Server side translates remote-ssh <-> file; the client speaks plain URIs
  // (the same asymmetry the daemon and the editor have).
  const serverCodec = options.translateUris
    ? createBinaryCodec(createRemoteURITransformer(AUTHORITY))
    : createBinaryCodec()
  const serverPair = options.jsonCodec
    ? new ChannelPair(a)
    : new ChannelPair(a, undefined, serverCodec)
  const clientPair = options.jsonCodec
    ? new ChannelPair(b)
    : new ChannelPair(b, undefined, createBinaryCodec())
  const serverDisposable = createRemoteServer(serverPair.server, undefined, {
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
  })
  return {
    triggers: ProxyChannel.toService<IRemoteTriggerService>(
      clientPair.client.getChannel(RemoteChannels.TriggerPoll),
    ),
    dispose: () => {
      serverDisposable.dispose()
      serverPair.dispose()
      clientPair.dispose()
      a.disconnect()
      b.disconnect()
    },
  }
}

async function writePollScript(dir: string, script: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'fetch.js'),
    script || "console.log(JSON.stringify([{ id: 'A', title: 't' }]))\n",
    'utf8',
  )
}

/** Seed `<dataDir>/triggers/runs/<clientId>/<runId>` directly on the server host. */
async function seedRun(
  dataDir: string,
  clientId: string,
  runId: string,
  options: { mtimeMs?: number; report?: string } = {},
): Promise<string> {
  const runDir = path.join(dataDir, 'triggers', 'runs', clientId, runId)
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(path.join(runDir, 'report.md'), options.report ?? `# ${runId}\n`, 'utf8')
  if (options.mtimeMs !== undefined) {
    await fs.utimes(runDir, options.mtimeMs / 1000, options.mtimeMs / 1000)
  }
  return runDir
}

describe('remote triggerPoll channel', () => {
  it('runs a poll command in a workspace on the server host', async () => {
    const dataDir = await makeTempRoot()
    const workspace = await makeTempRoot()
    await writePollScript(workspace, '')
    const { triggers, dispose } = connect({ dataDir })
    try {
      const result = await triggers.poll({
        command: 'node fetch.js',
        cwd: URI.file(workspace),
        timeoutSec: 20,
        keyField: 'id',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.items).toEqual([{ key: 'A', payload: { id: 'A', title: 't' } }])
      }
    } finally {
      dispose()
    }
  })

  it('fails loud on a missing cwd or a non-file URI', async () => {
    const dataDir = await makeTempRoot()
    const { triggers, dispose } = connect({ dataDir })
    try {
      await expect(
        triggers.poll({
          command: 'node -v',
          cwd: URI.file(path.join(dataDir, 'missing')),
          timeoutSec: 5,
          keyField: 'id',
        }),
      ).rejects.toThrow(/not an existing directory/)

      await expect(
        triggers.poll({
          command: 'node -v',
          cwd: URI.parse('remote-ssh://testhost/home/testuser/project'),
          timeoutSec: 5,
          keyField: 'id',
        }),
      ).rejects.toThrow(/file URI/)
    } finally {
      dispose()
    }
  })

  it('creates a run directory under dataDir/triggers/runs/<clientId>/', async () => {
    const dataDir = await makeTempRoot()
    const { triggers, dispose } = connect({ dataDir })
    try {
      const { runDir } = await triggers.createRunDir(CLIENT_ID, RUN_ID, {
        keep: 5,
        protectedRunIds: [],
      })
      expect(runDir).toBeInstanceOf(URI)
      expect(runDir.scheme).toBe('file')
      expect(path.normalize(runDir.fsPath)).toBe(
        path.normalize(path.join(dataDir, 'triggers', 'runs', CLIENT_ID, RUN_ID)),
      )
      expect((await fs.stat(runDir.fsPath)).isDirectory()).toBe(true)
    } finally {
      dispose()
    }
  })

  it('rejects malformed client ids and run ids instead of touching a path', async () => {
    const dataDir = await makeTempRoot()
    const { triggers, dispose } = connect({ dataDir })
    try {
      for (const clientId of ['', '..', '../escape', 'a/b', 'x'.repeat(65), 'bad id']) {
        await expect(
          triggers.createRunDir(clientId, RUN_ID, { keep: 1, protectedRunIds: [] }),
        ).rejects.toThrow(/invalid clientId/)
        await expect(
          triggers.cleanupRuns(clientId, { keep: 1, protectedRunIds: [] }),
        ).rejects.toThrow(/invalid clientId/)
        await expect(triggers.readReport(clientId, RUN_ID)).rejects.toThrow(/invalid clientId/)
      }
      for (const runId of ['', '..', '../escape', 'run-1', RUN_ID.replace('42d3', '62d3')]) {
        await expect(
          triggers.createRunDir(CLIENT_ID, runId, { keep: 1, protectedRunIds: [] }),
        ).rejects.toThrow(/invalid runId/)
        await expect(triggers.readReport(CLIENT_ID, runId)).rejects.toThrow(/invalid runId/)
      }
    } finally {
      dispose()
    }
  })

  it('cleanupRuns prunes only the given client namespace', async () => {
    const dataDir = await makeTempRoot()
    await seedRun(dataDir, CLIENT_ID, RUN_ID, { mtimeMs: 1_000 })
    await seedRun(dataDir, CLIENT_ID, OTHER_RUN_ID, { mtimeMs: 2_000 })
    await seedRun(dataDir, OTHER_CLIENT_ID, RUN_ID, { mtimeMs: 1_000 })
    const { triggers, dispose } = connect({ dataDir })
    try {
      const { removed } = await triggers.cleanupRuns(CLIENT_ID, {
        keep: 1,
        protectedRunIds: [],
      })
      expect(removed).toEqual([RUN_ID])
      const own = await fs.readdir(path.join(dataDir, 'triggers', 'runs', CLIENT_ID))
      expect(own).toEqual([OTHER_RUN_ID])
      const other = await fs.readdir(path.join(dataDir, 'triggers', 'runs', OTHER_CLIENT_ID))
      expect(other).toEqual([RUN_ID])
    } finally {
      dispose()
    }
  })

  it('honours protectedRunIds when pruning', async () => {
    const dataDir = await makeTempRoot()
    await seedRun(dataDir, CLIENT_ID, RUN_ID, { mtimeMs: 1_000 })
    await seedRun(dataDir, CLIENT_ID, OTHER_RUN_ID, { mtimeMs: 2_000 })
    const { triggers, dispose } = connect({ dataDir })
    try {
      const { removed } = await triggers.cleanupRuns(CLIENT_ID, {
        keep: 1,
        protectedRunIds: [RUN_ID],
      })
      expect(removed).toEqual([])
      const own = await fs.readdir(path.join(dataDir, 'triggers', 'runs', CLIENT_ID))
      expect(own.sort()).toEqual([OTHER_RUN_ID, RUN_ID].sort())
    } finally {
      dispose()
    }
  })

  it('reads report.md and maps not_found / too_large', async () => {
    const dataDir = await makeTempRoot()
    const seeded = await seedRun(dataDir, CLIENT_ID, RUN_ID, { report: '# Report\n\nbody' })
    const { triggers, dispose } = connect({ dataDir })
    try {
      const ok = await triggers.readReport(CLIENT_ID, RUN_ID)
      expect(ok.ok).toBe(true)
      if (ok.ok) {
        expect(Buffer.from(ok.bytes).toString('utf8')).toBe('# Report\n\nbody')
        expect(ok.bytes).toBeInstanceOf(Uint8Array)
        expect(path.normalize(ok.runDir.fsPath)).toBe(path.normalize(seeded))
        expect(ok.modifiedAt).toBeGreaterThan(0)
      }

      expect(await triggers.readReport(CLIENT_ID, OTHER_RUN_ID)).toEqual({
        ok: false,
        reason: 'not_found',
      })
      expect(await triggers.readReport(OTHER_CLIENT_ID, RUN_ID)).toEqual({
        ok: false,
        reason: 'not_found',
      })
      expect(await triggers.readReport(CLIENT_ID, RUN_ID, { maxBytes: 8 })).toEqual({
        ok: false,
        reason: 'too_large',
      })
    } finally {
      dispose()
    }
  })

  it('carries report bytes over the base64 JSON codec too', async () => {
    const dataDir = await makeTempRoot()
    await seedRun(dataDir, CLIENT_ID, RUN_ID, { report: 'binary-safe ✓' })
    const { triggers, dispose } = connect({ dataDir, jsonCodec: true })
    try {
      const result = await triggers.readReport(CLIENT_ID, RUN_ID)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.bytes).toBeInstanceOf(Uint8Array)
        expect(Buffer.from(result.bytes).toString('utf8')).toBe('binary-safe ✓')
        expect(result.bytes.byteLength).toBe(Buffer.byteLength('binary-safe ✓'))
      }
    } finally {
      dispose()
    }
  })

  it('round-trips remote-ssh <-> file URIs across the tunnel', async () => {
    const dataDir = await makeTempRoot()
    const workspace = await makeTempRoot()
    await writePollScript(workspace, '')
    const filePath = URI.file(workspace).path
    const remoteWorkspace = URI.parse(`${'remote-ssh'}://${AUTHORITY}${filePath}`)

    const { triggers, dispose } = connect({ dataDir, translateUris: true })
    try {
      const result = await triggers.poll({
        command: 'node fetch.js',
        cwd: remoteWorkspace,
        timeoutSec: 20,
        keyField: 'id',
      })
      expect(result.ok).toBe(true)

      const { runDir } = await triggers.createRunDir(CLIENT_ID, RUN_ID, {
        keep: 1,
        protectedRunIds: [],
      })
      expect(runDir.scheme).toBe('remote-ssh')
      expect(runDir.authority).toBe(AUTHORITY)
      expect(runDir.path.split('/').slice(-2)).toEqual([CLIENT_ID, RUN_ID])
      expect(runDir.fsPath).toBeTruthy()

      const report = await triggers.readReport(CLIENT_ID, RUN_ID)
      expect(report.ok).toBe(false)
    } finally {
      dispose()
    }
  })
})
