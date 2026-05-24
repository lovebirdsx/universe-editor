/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  LogTailContribution — appends new log chunks from the main-side LogMainService
 *  to the matching log Output channel in real time, so the panel updates
 *  as the log file grows without requiring a manual Refresh.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IOutputService,
  autorun,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { ILogFilesService, type LogAppendEvent } from '../../shared/ipc/services.js'

const LOG_READ_MAX_BYTES = 1024 * 1024

export class LogTailContribution extends Disposable implements IWorkbenchContribution {
  private readonly _nameToChannelId = new Map<string, string>()
  private readonly _nameToDescriptorId = new Map<string, string>()
  private readonly _channelIdToName = new Map<string, string>()
  private readonly _pending = new Map<string, string>()
  private _flushScheduled = false
  private _refreshing = false

  constructor(
    @ILogFilesService private readonly _logFiles: ILogFilesService,
    @IOutputService private readonly _output: IOutputService,
  ) {
    super()
    void this._refreshDescriptors()
    this._register(this._logFiles.onDidAppendEntry((event) => this._handleAppend(event)))
    // Lazy-load file content the first time a log channel becomes active —
    // covers both the restore path (channel restored as active by OutputService
    // before LogTailContribution finishes refreshing descriptors) and any future
    // direct activation that bypasses Show Logs...
    this._register(
      autorun((r) => {
        const active = this._output.activeChannelName.read(r)
        if (!active || this._output.activeChannel?.kind !== 'log') return
        void this._populateLogChannelIfEmpty(active)
      }),
    )
  }

  private async _refreshDescriptors(): Promise<void> {
    if (this._refreshing) return
    this._refreshing = true
    try {
      const descriptors = await this._logFiles.listLogFiles()
      this._nameToChannelId.clear()
      this._nameToDescriptorId.clear()
      this._channelIdToName.clear()
      for (const d of descriptors) {
        this._nameToChannelId.set(d.name, d.channelId)
        this._nameToDescriptorId.set(d.name, d.id)
        this._channelIdToName.set(d.channelId, d.name)
        // Pre-create the channel so it appears in the Output dropdown and so
        // OutputService can activate it when it matches a pending restored name.
        this._output.createChannel(d.name, 'log')
      }
    } catch {
      // best-effort; next event will retry
    } finally {
      this._refreshing = false
    }
  }

  private async _populateLogChannelIfEmpty(channelName: string): Promise<void> {
    const channel = this._output.getChannel(channelName)
    if (!channel || channel.content.get() !== '') return
    const name = channelName
    let descriptorId = this._nameToDescriptorId.get(name)
    if (descriptorId === undefined) {
      await this._refreshDescriptors()
      descriptorId = this._nameToDescriptorId.get(name)
    }
    if (descriptorId === undefined) return
    let content: string
    try {
      content = await this._logFiles.readLogFile(descriptorId, LOG_READ_MAX_BYTES)
    } catch {
      return
    }
    if (typeof content !== 'string') return
    if (channel.content.get() !== '') return
    channel.append(content)
  }

  private _handleAppend(event: LogAppendEvent): void {
    // An append from a previously unknown channelId means a new logger
    // materialized after the initial _refreshDescriptors snapshot — flushes
    // are debounced by 150ms in main, so the .log file may not have existed
    // when we first listed. Refresh now so the corresponding log channel
    // is created and any pending restore can activate it.
    if (!this._channelIdToName.has(event.channelId)) {
      void this._refreshDescriptors()
    }

    const active = this._output.activeChannelName.get()
    if (!active || this._output.activeChannel?.kind !== 'log') {
      return
    }

    const name = active
    const mapped = this._nameToChannelId.get(name)
    if (mapped === undefined) {
      // Descriptor cache miss — refresh in the background so the next chunk
      // for this channel finds it. Drop the current chunk; the panel can be
      // re-synced manually via Developer: Refresh Log Output if needed.
      void this._refreshDescriptors()
      return
    }

    if (mapped !== event.channelId) {
      return
    }

    const prev = this._pending.get(active) ?? ''
    this._pending.set(active, prev + event.chunk)
    if (!this._flushScheduled) {
      this._flushScheduled = true
      queueMicrotask(() => this._flushPending())
    }
  }

  private _flushPending(): void {
    this._flushScheduled = false
    for (const [name, chunk] of this._pending) {
      if (!chunk) continue
      const channel = this._output.getChannel(name)
      if (channel) channel.append(chunk)
    }
    this._pending.clear()
  }
}
