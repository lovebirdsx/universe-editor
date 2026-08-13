/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Deterministic unit tests for RemoteFileStreamService's windowed streaming.
 *  A fake ReadStream lets the test control exactly when chunks / end / error are
 *  emitted relative to the first `onReadStreamData` subscription, which is what
 *  the real daemon's timing cannot guarantee (and what used to drop early chunks).
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileService,
  NullLogger,
  URI,
  type IRemoteFileStreamEvent,
} from '@universe-editor/platform'
import { RemoteFileStreamService } from '../fileStreamService.js'

const CHUNK_SIZE = 262144

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

function makeBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff
  return b
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

async function flushMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

class FakeReadStream {
  paused = false
  destroyed = false
  resumeCalls = 0
  private readonly dataCbs: Array<(chunk: Buffer) => void> = []
  private readonly endCbs: Array<() => void> = []
  private readonly errorCbs: Array<(err: Error) => void> = []

  on(event: string, cb: (...args: never[]) => void): this {
    if (event === 'data') this.dataCbs.push(cb as (chunk: Buffer) => void)
    else if (event === 'end') this.endCbs.push(cb as () => void)
    else if (event === 'error') this.errorCbs.push(cb as (err: Error) => void)
    return this
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.resumeCalls++
  }

  destroy(): void {
    this.destroyed = true
  }

  emitData(chunk: Buffer): void {
    for (const cb of this.dataCbs) cb(chunk)
  }

  emitEnd(): void {
    for (const cb of this.endCbs) cb()
  }

  emitError(err: Error): void {
    for (const cb of this.errorCbs) cb(err)
  }
}

describe('RemoteFileStreamService', () => {
  it('replays chunks emitted before the first subscription instead of dropping them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ue-fss-'))
    tempRoots.push(root)
    const filePath = path.join(root, 'big.bin')
    const expected = makeBytes(20 * CHUNK_SIZE)
    await writeFile(filePath, expected)

    let fake: FakeReadStream | undefined
    const service = new RemoteFileStreamService(new FileService(), new NullLogger(), () => {
      fake = new FakeReadStream()
      return fake as unknown as ReadStream
    })

    const { streamId, size } = await service.startReadStream(URI.file(filePath))
    expect(size).toBe(expected.length)
    expect(fake).toBeDefined()

    const chunkAt = (seq: number): Buffer =>
      Buffer.from(expected.subarray(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE))

    // Emit the full 16-chunk window before any subscriber exists: the service
    // must buffer them (not drop them) and pause the underlying stream.
    for (let seq = 0; seq < 16; seq++) fake!.emitData(chunkAt(seq))
    expect(fake!.paused).toBe(true)

    const chunks: Uint8Array[] = []
    const seqs: number[] = []
    let doneSeq = -1
    service.onReadStreamData((e: IRemoteFileStreamEvent) => {
      if (e.streamId !== streamId) return
      if (e.done) {
        doneSeq = e.seq
        return
      }
      if (e.data !== undefined) {
        seqs.push(e.seq)
        chunks.push(e.data)
        void service.ackReadStream(streamId, e.seq)
      }
    })

    // The BufferedEmitter replays the buffered window on a microtask; the acks
    // then resume the paused stream.
    await flushMicrotasks()
    expect(seqs).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(fake!.resumeCalls).toBeGreaterThan(0)

    // Emit the remaining chunks and the terminal frame.
    for (let seq = 16; seq < 20; seq++) fake!.emitData(chunkAt(seq))
    fake!.emitEnd()

    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(doneSeq).toBe(20)
    const reassembled = concatBytes(chunks)
    expect(reassembled.length).toBe(expected.length)
    expect(Buffer.from(reassembled).equals(Buffer.from(expected))).toBe(true)

    service.dispose()
  })
})
