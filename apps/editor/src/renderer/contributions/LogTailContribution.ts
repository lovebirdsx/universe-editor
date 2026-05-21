/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  LogTailContribution — appends new log chunks from the main-side LogMainService
 *  to the matching `Log (X)` Output channel in real time, so the panel updates
 *  as the log file grows without requiring a manual Refresh.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IOutputService, type IWorkbenchContribution } from '@universe-editor/platform'
import { ILogFilesService, type LogAppendEvent } from '../../shared/ipc/services.js'

const LOG_CHANNEL_PREFIX = 'Log ('

export class LogTailContribution extends Disposable implements IWorkbenchContribution {
  private readonly _nameToChannelId = new Map<string, string>()
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
  }

  private async _refreshDescriptors(): Promise<void> {
    if (this._refreshing) return
    this._refreshing = true
    try {
      const descriptors = await this._logFiles.listLogFiles()
      this._nameToChannelId.clear()
      for (const d of descriptors) {
        this._nameToChannelId.set(d.name, d.channelId)
      }
    } catch {
      // best-effort; next event will retry
    } finally {
      this._refreshing = false
    }
  }

  private _handleAppend(event: LogAppendEvent): void {
    const active = this._output.activeChannelName.get()
    if (!active || !active.startsWith(LOG_CHANNEL_PREFIX) || !active.endsWith(')')) {
      return
    }

    const name = active.slice(LOG_CHANNEL_PREFIX.length, -1)
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
