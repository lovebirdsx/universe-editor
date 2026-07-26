/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IOutputService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  IStorageService,
  StorageScope,
  observableValue,
  derived,
  transaction,
} from '@universe-editor/platform'
import type {
  IOutputService,
  IOutputChannel,
  IOutputChannelFlushEvent,
} from '@universe-editor/platform'

const OUTPUT_ACTIVE_CHANNEL_KEY = 'output.activeChannel'

/**
 * Hard cap on the characters an OutputChannel retains in memory. High-volume
 * producers — notably the ACP protocol tracer, which appends a multi-line
 * pretty-JSON block for every `session/update` chunk — would otherwise grow it
 * without bound and OOM the renderer over a long agent session (observed:
 * reason=oom in main.log). When the retained content exceeds this, the oldest
 * lines are dropped so the tail (the interesting, recent part of any log) is
 * always kept.
 */
const MAX_RETAINED_CHARS = 4 * 1024 * 1024

/**
 * Extra headroom kept before trimming, so a channel at the limit doesn't
 * re-trim on every single flush. Mirrors the terminal scrollback compaction in
 * TerminalManagerService.
 */
const TRIM_SLACK_CHARS = 256 * 1024

export class OutputChannel implements IOutputChannel {
  private _chunks: string[] = []
  private _pending: string[] = []
  private _length = 0
  private _flushScheduled = false
  private _disposed = false

  private readonly _onDidFlush = new Emitter<IOutputChannelFlushEvent>()
  readonly onDidFlush = this._onDidFlush.event
  private readonly _onDidClear = new Emitter<void>()
  readonly onDidClear = this._onDidClear.event

  readonly hasContent = observableValue<boolean>('OutputChannel.hasContent', false)

  constructor(
    readonly name: string,
    readonly kind: string = 'default',
    private readonly _onDispose: () => void,
  ) {}

  append(text: string): void {
    if (!text || this._disposed) return
    this._pending.push(text)
    if (!this.hasContent.get()) this.hasContent.set(true, undefined)
    if (!this._flushScheduled) {
      this._flushScheduled = true
      queueMicrotask(() => this._flush())
    }
  }

  appendLine(text: string): void {
    this.append(text + '\n')
  }

  clear(): void {
    if (this._disposed) return
    if (this._length === 0 && this._pending.length === 0) return
    this._chunks = []
    this._pending = []
    this._length = 0
    this.hasContent.set(false, undefined)
    this._onDidClear.fire()
  }

  getText(): string {
    return this._chunks.join('') + this._pending.join('')
  }

  flushNow(): void {
    // Idempotent: the already-queued microtask finds _pending empty and returns.
    this._flush()
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._chunks = []
    this._pending = []
    this._length = 0
    this._onDidFlush.dispose()
    this._onDidClear.dispose()
    this._onDispose()
  }

  private _flush(): void {
    this._flushScheduled = false
    if (this._disposed || this._pending.length === 0) return
    const delta = this._pending.join('')
    this._pending = []
    this._chunks.push(delta)
    this._length += delta.length
    const trimmedChars = this._trimHead()
    this._onDidFlush.fire({ appendedText: delta, trimmedChars })
  }

  /**
   * Drop whole chunks (plus a line-boundary slice of the first retained chunk)
   * from the head to get back under {@link MAX_RETAINED_CHARS}. Mirrors the old
   * whole-string semantics: cut at the first '\n' at/after the cutoff so the
   * retained text never starts mid-line, hard-cutting a gigantic tail line.
   */
  private _trimHead(): number {
    if (this._length <= MAX_RETAINED_CHARS + TRIM_SLACK_CHARS) return 0
    const cutoff = this._length - MAX_RETAINED_CHARS
    let offset = 0
    for (let i = 0; i < this._chunks.length; i++) {
      const chunk = this._chunks[i]!
      if (offset + chunk.length <= cutoff) {
        offset += chunk.length
        continue
      }
      const localCut = cutoff - offset
      // Find the first newline at/after the cutoff, scanning into later chunks.
      let nlChunk = i
      let nlLocal = chunk.indexOf('\n', localCut)
      while (nlLocal < 0 && nlChunk + 1 < this._chunks.length) {
        nlChunk++
        nlLocal = this._chunks[nlChunk]!.indexOf('\n')
      }
      if (nlLocal >= 0) {
        const removed = this._dropHead(nlChunk, nlLocal + 1)
        return removed
      }
      return this._dropHead(i, localCut)
    }
    return 0
  }

  /** Drop `chunkCount` whole chunks plus `sliceChars` of the next chunk. */
  private _dropHead(chunkCount: number, sliceChars: number): number {
    let removed = sliceChars
    for (let j = 0; j < chunkCount; j++) removed += this._chunks[j]!.length
    this._chunks.splice(0, chunkCount)
    this._chunks[0] = this._chunks[0]!.slice(sliceChars)
    this._length -= removed
    return removed
  }
}

export class OutputService extends Disposable implements IOutputService {
  declare readonly _serviceBrand: undefined

  private readonly _channels = new Map<string, OutputChannel>()
  private _pendingRestoredChannelName: string | undefined

  private readonly _onDidRemoveChannel = this._register(new Emitter<string>())
  readonly onDidRemoveChannel = this._onDidRemoveChannel.event

  readonly channelNames = observableValue<readonly string[]>('OutputService.channelNames', [])
  readonly activeChannelName = observableValue<string | undefined>(
    'OutputService.activeChannelName',
    undefined,
  )
  readonly activeChannelHasContent = derived(this, (r) => {
    const name = this.activeChannelName.read(r)
    if (!name) return false
    const channel = this._channels.get(name)
    return channel ? channel.hasContent.read(r) : false
  })

  constructor(@IStorageService private readonly _storage: IStorageService) {
    super()
    void this._loadRestoredChannel()
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        void this._loadRestoredChannel()
      }),
    )
  }

  private async _loadRestoredChannel(): Promise<void> {
    const name = await this._storage.get<string>(OUTPUT_ACTIVE_CHANNEL_KEY, StorageScope.WORKSPACE)
    if (!name) return
    if (this._channels.has(name)) {
      this.activeChannelName.set(name, undefined)
    } else {
      this._pendingRestoredChannelName = name
    }
  }

  createChannel(name: string, kind?: string): IOutputChannel {
    const existing = this._channels.get(name)
    if (existing) return existing

    const channel = new OutputChannel(name, kind, () => this._removeChannel(name))
    this._channels.set(name, channel)
    transaction((tx) => {
      this.channelNames.set([...this.channelNames.get(), name], tx)
      if (this.activeChannelName.get() === undefined) {
        this.activeChannelName.set(name, tx)
      } else if (this._matchesPending(name)) {
        this.activeChannelName.set(name, tx)
        this._pendingRestoredChannelName = undefined
      }
    })

    return channel
  }

  /**
   * Checks whether a new channel name is a suitable match for the pending
   * restored channel name. Supports exact matches and acp/<agentId>/<handle>
   * channels where only the first two path segments identify the agent — the
   * third segment (handle) rotates every session.
   */
  private _matchesPending(channelName: string): boolean {
    const saved = this._pendingRestoredChannelName
    if (saved === undefined) return false
    if (channelName === saved) return true
    // acp/<agentId>/<handle>: match by acp/<agentId>/ prefix so that a new
    // handle for the same agent is accepted as a restore target.
    const parts = saved.split('/')
    if (parts[0] === 'acp' && parts.length === 3) {
      return channelName.startsWith(`acp/${parts[1]!}/`)
    }
    return false
  }

  private _removeChannel(name: string): void {
    if (!this._channels.delete(name)) return
    if (this._pendingRestoredChannelName === name) {
      this._pendingRestoredChannelName = undefined
    }
    transaction((tx) => {
      this.channelNames.set(
        this.channelNames.get().filter((n) => n !== name),
        tx,
      )
      if (this.activeChannelName.get() === name) {
        const fallback = this._channels.keys().next().value
        this.activeChannelName.set(fallback, tx)
        if (fallback !== undefined) {
          void this._storage.set(OUTPUT_ACTIVE_CHANNEL_KEY, fallback, StorageScope.WORKSPACE)
        } else {
          void this._storage.remove(OUTPUT_ACTIVE_CHANNEL_KEY, StorageScope.WORKSPACE)
        }
      }
    })
    this._onDidRemoveChannel.fire(name)
  }

  getChannel(name: string): IOutputChannel | undefined {
    return this._channels.get(name)
  }

  getChannels(): readonly IOutputChannel[] {
    return [...this._channels.values()]
  }

  get activeChannel(): IOutputChannel | undefined {
    const name = this.activeChannelName.get()
    return name === undefined ? undefined : this._channels.get(name)
  }

  get hasPendingRestoredChannel(): boolean {
    return this._pendingRestoredChannelName !== undefined
  }

  setActiveChannel(name: string): void {
    if (!this._channels.has(name)) return
    if (this.activeChannelName.get() === name) return
    this.activeChannelName.set(name, undefined)
    void this._storage.set(OUTPUT_ACTIVE_CHANNEL_KEY, name, StorageScope.WORKSPACE)
  }

  override dispose(): void {
    // Disposing a channel triggers _removeChannel; Map iteration tolerates
    // deletion of the current entry.
    for (const channel of this._channels.values()) {
      channel.dispose()
    }
    super.dispose()
  }
}
