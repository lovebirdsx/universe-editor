/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote FileSystem channel surface: the headless local IFileService plus a
 *  multiplexed streaming reader. Large reads are pushed as 256KB chunks through
 *  `onReadStreamData` with windowed flow control (16 unacknowledged chunks in
 *  flight, advanced by `ackReadStream`) instead of one response frame, so a
 *  multi-MB file never head-of-line blocks every other channel message.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream, type ReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  BufferedEmitter,
  Disposable,
  FileService,
  type Event,
  type IDirectoryEntry,
  type IFileStat,
  type ILogger,
  type IRemoteFileStreamEvent,
  type IRemoteFileStreamService,
  type URI,
} from '@universe-editor/platform'

const CHUNK_SIZE = 262144
const MAX_IN_FLIGHT = 16

type ReadStreamFactory = (fsPath: string, options: { highWaterMark: number }) => ReadStream

interface ActiveStream {
  readonly readStream: ReadStream
  readonly size: number
  sent: number
  lastAcked: number
  paused: boolean
}

export class RemoteFileStreamService extends Disposable implements IRemoteFileStreamService {
  declare readonly _serviceBrand: undefined

  // Buffered so chunks emitted before the client's first subscription are replayed instead of dropped.
  private readonly _onReadStreamData = this._register(new BufferedEmitter<IRemoteFileStreamEvent>())
  readonly onReadStreamData: Event<IRemoteFileStreamEvent> = this._onReadStreamData.event

  private _nextStreamId = 1
  private readonly _streams = new Map<number, ActiveStream>()

  constructor(
    private readonly _fileService: FileService,
    private readonly _logger: ILogger,
    private readonly _createReadStream: ReadStreamFactory = createReadStream,
  ) {
    super()
  }

  // -------- IFileService delegation --------

  readFile(resource: URI): Promise<Uint8Array> {
    return this._fileService.readFile(resource)
  }

  readFileHead(resource: URI, maxBytes: number): Promise<Uint8Array> {
    return this._fileService.readFileHead(resource, maxBytes)
  }

  readFileText(resource: URI, encoding?: 'utf8'): Promise<string> {
    return this._fileService.readFileText(resource, encoding)
  }

  writeFile(resource: URI, content: Uint8Array | string): Promise<void> {
    return this._fileService.writeFile(resource, content)
  }

  exists(resource: URI): Promise<boolean> {
    return this._fileService.exists(resource)
  }

  stat(resource: URI): Promise<IFileStat> {
    return this._fileService.stat(resource)
  }

  list(resource: URI): Promise<IDirectoryEntry[]> {
    return this._fileService.list(resource)
  }

  realpath(resource: URI): Promise<URI> {
    return this._fileService.realpath(resource)
  }

  listDrives(): Promise<string[]> {
    return this._fileService.listDrives()
  }

  createDirectory(resource: URI): Promise<void> {
    return this._fileService.createDirectory(resource)
  }

  delete(resource: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    return this._fileService.delete(resource, opts)
  }

  rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    return this._fileService.rename(source, target, opts)
  }

  copy(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    return this._fileService.copy(source, target, opts)
  }

  listRecursive(
    root: URI,
    options?: { ignore?: readonly string[]; maxFiles?: number; maxDepth?: number },
  ): Promise<URI[]> {
    return this._fileService.listRecursive(root, options)
  }

  // -------- streaming reader --------

  async startReadStream(resource: URI): Promise<{ streamId: number; size: number }> {
    const fsPath = resource.fsPath
    const fileStat = await stat(fsPath)
    if (!fileStat.isFile()) {
      throw new Error(`cannot stream non-file resource: ${fsPath}`)
    }
    const streamId = this._nextStreamId++
    const readStream = this._createReadStream(fsPath, { highWaterMark: CHUNK_SIZE })
    const entry: ActiveStream = {
      readStream,
      size: fileStat.size,
      sent: 0,
      lastAcked: -1,
      paused: false,
    }
    this._streams.set(streamId, entry)

    readStream.on('data', (chunk) => {
      const current = this._streams.get(streamId)
      if (!current || current.readStream !== readStream) return
      const seq = current.sent
      current.sent++
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      this._onReadStreamData.fire({ streamId, seq, data })
      if (current.sent - (current.lastAcked + 1) >= MAX_IN_FLIGHT) {
        current.paused = true
        readStream.pause()
      }
    })
    readStream.on('end', () => {
      const current = this._streams.get(streamId)
      if (!current) return
      this._streams.delete(streamId)
      this._onReadStreamData.fire({ streamId, seq: current.sent, done: true })
    })
    readStream.on('error', (err) => {
      const current = this._streams.get(streamId)
      if (!current) return
      this._streams.delete(streamId)
      const code = (err as NodeJS.ErrnoException).code
      this._onReadStreamData.fire({
        streamId,
        seq: current.sent,
        error: { message: err.message, ...(code ? { code } : {}) },
      })
    })

    this._logger.debug(`[remote-stream] start stream=${streamId} size=${fileStat.size}`)
    return { streamId, size: fileStat.size }
  }

  ackReadStream(streamId: number, receivedSeq: number): Promise<void> {
    const entry = this._streams.get(streamId)
    if (!entry) return Promise.resolve()
    if (receivedSeq <= entry.lastAcked) return Promise.resolve()
    entry.lastAcked = receivedSeq
    const inFlight = entry.sent - (entry.lastAcked + 1)
    if (entry.paused && inFlight < MAX_IN_FLIGHT) {
      entry.paused = false
      entry.readStream.resume()
    }
    return Promise.resolve()
  }

  cancelReadStream(streamId: number): Promise<void> {
    const entry = this._streams.get(streamId)
    if (!entry) return Promise.resolve()
    this._streams.delete(streamId)
    entry.readStream.destroy()
    this._logger.debug(`[remote-stream] cancel stream=${streamId}`)
    return Promise.resolve()
  }

  override dispose(): void {
    for (const entry of this._streams.values()) {
      entry.readStream.destroy()
    }
    this._streams.clear()
    super.dispose()
  }
}
