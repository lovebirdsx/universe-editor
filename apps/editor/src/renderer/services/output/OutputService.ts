/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IOutputService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  StorageScope,
  observableValue,
  derived,
  transaction,
} from '@universe-editor/platform'
import type { IOutputService, IOutputChannel } from '@universe-editor/platform'

const OUTPUT_ACTIVE_CHANNEL_KEY = 'output.activeChannel'

/**
 * Hard cap on the characters an OutputChannel retains in memory. A channel's
 * content is a single string that observers (the Output panel) subscribe to;
 * high-volume producers — notably the ACP protocol tracer, which appends a
 * multi-line pretty-JSON block for every `session/update` chunk — would
 * otherwise grow it without bound and OOM the renderer over a long agent
 * session (observed: reason=oom in main.log). When the retained content exceeds
 * this, the oldest lines are dropped so the tail (the interesting, recent part
 * of any log) is always kept.
 */
const MAX_RETAINED_CHARS = 4 * 1024 * 1024

/**
 * Extra headroom kept before trimming, so a channel at the limit doesn't
 * re-scan + reallocate on every single append. Mirrors the terminal
 * scrollback compaction in TerminalManagerService.
 */
const TRIM_SLACK_CHARS = 256 * 1024

export class OutputChannel implements IOutputChannel {
  readonly content = observableValue<string>('OutputChannel.content', '')

  constructor(
    readonly name: string,
    readonly kind: string = 'default',
  ) {}

  append(text: string): void {
    this.content.set(this._capped(this.content.get() + text), undefined)
  }

  appendLine(text: string): void {
    this.append(text + '\n')
  }

  /**
   * Trim `next` from the head to stay under {@link MAX_RETAINED_CHARS}, cutting
   * at a line boundary so the retained log never starts mid-line. Only runs once
   * the content exceeds the cap plus a slack window, keeping the steady-state
   * append a no-op string concat.
   */
  private _capped(next: string): string {
    if (next.length <= MAX_RETAINED_CHARS + TRIM_SLACK_CHARS) return next
    const cutoff = next.length - MAX_RETAINED_CHARS
    const nl = next.indexOf('\n', cutoff)
    // Prefer the next line boundary at/after the cutoff; fall back to a hard cut
    // if the tail is one gigantic line with no newline.
    return nl >= 0 ? next.slice(nl + 1) : next.slice(cutoff)
  }

  clear(): void {
    this.content.set('', undefined)
  }

  dispose(): void {}
}

export class OutputService extends Disposable implements IOutputService {
  declare readonly _serviceBrand: undefined

  private readonly _channels = new Map<string, OutputChannel>()
  private _pendingRestoredChannelName: string | undefined

  readonly channelNames = observableValue<readonly string[]>('OutputService.channelNames', [])
  readonly activeChannelName = observableValue<string | undefined>(
    'OutputService.activeChannelName',
    undefined,
  )
  readonly activeChannelContent = derived(this, (r) => {
    const name = this.activeChannelName.read(r)
    if (!name) return ''
    const channel = this._channels.get(name)
    return channel ? channel.content.read(r) : ''
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

    const channel = new OutputChannel(name, kind)
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
}
