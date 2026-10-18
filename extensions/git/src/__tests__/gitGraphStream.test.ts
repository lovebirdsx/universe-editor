import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitGraphCommitBatchDto, GitGraphCommitDto } from '@universe-editor/extensions-common'
import type { GitExecResult } from '../gitService.js'

const { spawnMock, metadataMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  metadataMock: vi.fn(),
}))

vi.mock('../gitService.js', () => ({ gitSpawnStream: spawnMock }))
vi.mock('../gitGraphSource.js', () => ({ loadGraphMetadata: metadataMock }))

import { cancelAllCommitStreams, cancelCommitStream, startCommitStream } from '../gitGraphStream.js'

const FIELD = '\x1f'

function record(hash: string, subject: string, date: number): string {
  return [hash, '', 'Ann', 'ann@example.com', String(date), subject].join(FIELD) + '\0'
}

function stash(hash: string, date: number): GitGraphCommitDto {
  return {
    hash,
    parents: [],
    author: '',
    email: '',
    date,
    message: `stash ${hash}`,
    heads: [],
    tags: [],
    remotes: [],
    stash: { selector: `stash@{0}`, base: null } as unknown as GitGraphCommitDto['stash'],
    worktrees: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface FakeProcess {
  child: EventEmitter & {
    stdout: AsyncIterable<Buffer>
    kill: ReturnType<typeof vi.fn>
  }
  gates: Array<{ promise: Promise<void>; resolve: () => void }>
  done: Promise<GitExecResult>
}

/** A child whose stdout chunks are released one by one by the test. */
function fakeProcess(
  chunks: string[],
  exitCode = 0,
  stderr = '',
  onReadStart?: () => void,
): FakeProcess {
  const child = new EventEmitter() as FakeProcess['child']
  const gates = chunks.map(() => {
    const d = deferred<void>()
    return { promise: d.promise, resolve: () => d.resolve() }
  })
  let killed = false
  const done = deferred<GitExecResult>()
  child.stdout = (async function* () {
    try {
      onReadStart?.()
      for (let i = 0; i < chunks.length; i++) {
        await gates[i]!.promise
        if (killed) return
        yield Buffer.from(chunks[i]!)
      }
    } finally {
      done.resolve({ stdout: '', stderr, exitCode: killed ? 143 : exitCode })
    }
  })()
  child.kill = vi.fn(() => {
    killed = true
    for (const gate of gates) gate.resolve()
  }) as unknown as FakeProcess['child']['kill']
  queueMicrotask(() => child.emit('spawn'))
  return { child, gates, done: done.promise }
}

function metadataValue(stashes: GitGraphCommitDto[] = []) {
  return {
    refs: {
      head: 'aaa',
      headName: 'main',
      heads: new Map([['aaa', ['main']]]),
      tags: new Map(),
      remotes: new Map(),
    },
    uncommittedChanges: 0,
    stashes,
    worktrees: null,
  }
}

function setupMetadata(stashes: GitGraphCommitDto[] = []): void {
  metadataMock.mockResolvedValue(metadataValue(stashes))
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for stream')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function collect(
  streamId: string,
  chunks: string[],
  maxCommits?: number,
): Promise<{
  batches: GitGraphCommitBatchDto[]
  process: FakeProcess
}> {
  const process = fakeProcess(chunks)
  spawnMock.mockReturnValue({ child: process.child, done: process.done })
  const batches: GitGraphCommitBatchDto[] = []
  const started = await startCommitStream(
    '/repo',
    { streamId, ...(maxCommits !== undefined ? { maxCommits } : {}) },
    async (batch) => {
      batches.push(batch)
      return true
    },
  )
  expect(started).toBe(true)
  // Release every chunk so the stream reaches its terminal batch.
  for (const gate of process.gates) gate.resolve()
  await waitFor(() => batches.some((b) => b.done === true))
  return { batches, process }
}

describe('gitGraphStream', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    metadataMock.mockReset()
    setupMetadata()
  })
  afterEach(() => {
    cancelAllCommitStreams()
    vi.restoreAllMocks()
  })

  it('emits metadata on the first batch and commits in log order', async () => {
    const { batches } = await collect('s1', [
      record('bbb', 'second', 200),
      record('aaa', 'first', 100),
    ])
    expect(batches).toHaveLength(1)
    const batch = batches[0]!
    expect(batch).toMatchObject({ streamId: 's1', seq: 0, logCount: 2, done: true })
    expect(batch.meta).toEqual({ head: 'aaa', headName: 'main', uncommittedChanges: 0 })
    expect(batch.commits.map((c) => c.hash)).toEqual(['bbb', 'aaa'])
    expect(batch.commits[0]!.heads).toEqual([])
    expect(batch.commits[1]!.heads).toEqual(['main'])
  })

  it('inserts stashes by date, mirroring mergeByDateDesc', async () => {
    setupMetadata([stash('stash250', 250), stash('stash150', 150)])
    const { batches } = await collect('s2', [
      record('c300', 'new', 300),
      record('c100', 'old', 100),
    ])
    expect(batches.at(-1)!.commits.map((c) => c.hash)).toEqual([
      'c300',
      'stash250',
      'stash150',
      'c100',
    ])
  })

  it('stops at maxCommits and reports moreAvailable without an error', async () => {
    const chunks = ['aaa', 'bbb', 'ccc'].map((hash, i) => record(hash, `c${i}`, 300 - i * 100))
    const { batches, process } = await collect('s3', chunks, 2)
    const terminal = batches.at(-1)!
    expect(terminal.done).toBe(true)
    expect(terminal.error).toBeUndefined()
    expect(terminal.moreAvailable).toBe(true)
    expect(terminal.commits.map((c) => c.hash)).toEqual(['aaa', 'bbb'])
    expect(process.child.kill).toHaveBeenCalled()
  })

  it('cancels a running stream and ignores subsequent chunks', async () => {
    setupMetadata()
    const process = fakeProcess([record('aaa', 'first', 100), record('bbb', 'second', 50)])
    spawnMock.mockReturnValue({ child: process.child, done: process.done })
    const batches: GitGraphCommitBatchDto[] = []
    await startCommitStream('/repo', { streamId: 's4' }, async (batch) => {
      batches.push(batch)
      return true
    })
    await waitFor(() => spawnMock.mock.calls.length === 1)
    expect(cancelCommitStream('s4')).toBe(true)
    expect(cancelCommitStream('s4')).toBe(false)
    expect(process.child.kill).toHaveBeenCalled()
    for (const gate of process.gates) gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(batches.every((b) => b.done !== true)).toBe(true)
  })

  it('reports a non-zero exit as a terminal error after the delivered commits', async () => {
    const process = fakeProcess([record('aaa', 'first', 100) + 'truncated'], 1, 'fatal: bad object')
    spawnMock.mockReturnValue({ child: process.child, done: process.done })
    const batches: GitGraphCommitBatchDto[] = []
    await startCommitStream('/repo', { streamId: 's5' }, async (batch) => {
      batches.push(batch)
      return true
    })
    for (const gate of process.gates) gate.resolve()
    await waitFor(() => batches.some((b) => b.done === true))
    const terminal = batches.at(-1)!
    expect(terminal.error).toBe('fatal: bad object')
    expect(terminal.commits.map((c) => c.hash)).toEqual(['aaa'])
  })

  it('attaches the stdout reader before metadata resolves', async () => {
    // Regression: awaiting metadata before iterating stdout lets git finish and
    // exit with its output dropped, producing an empty stream on real repos.
    const meta = deferred<ReturnType<typeof metadataValue>>()
    metadataMock.mockReturnValue(meta.promise)
    let reading = false
    const process = fakeProcess([record('aaa', 'first', 100)], 0, '', () => (reading = true))
    spawnMock.mockReturnValue({ child: process.child, done: process.done })
    const batches: GitGraphCommitBatchDto[] = []
    await startCommitStream('/repo', { streamId: 's-early' }, async (batch) => {
      batches.push(batch)
      return true
    })
    process.gates[0]!.resolve()
    await waitFor(() => reading)
    // The reader is live while the first batch still waits for metadata.
    expect(batches).toHaveLength(0)
    meta.resolve(metadataValue())
    await waitFor(() => batches.some((b) => b.done === true))
    expect(batches.at(-1)!.commits.map((c) => c.hash)).toEqual(['aaa'])
  })

  it('a new stream supersedes the old one', async () => {
    const first = fakeProcess([record('aaa', 'first', 100)])
    spawnMock.mockReturnValueOnce({ child: first.child, done: first.done })
    await startCommitStream('/repo', { streamId: 'old' }, async () => true)
    const second = fakeProcess([record('bbb', 'second', 100)])
    spawnMock.mockReturnValueOnce({ child: second.child, done: second.done })
    await startCommitStream('/repo', { streamId: 'new' }, async () => true)
    expect(first.child.kill).toHaveBeenCalled()
    expect(cancelCommitStream('old')).toBe(false)
  })
})
