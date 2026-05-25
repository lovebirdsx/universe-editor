/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AggregatedLogChannelContribution — creates the "All" Output channel that
 *  merges log entries from every other log channel in time order, so users
 *  can see cross-channel activity without flipping the dropdown.
 *
 *  Data flow:
 *    LogMainService.FileLogger → fires onDidAppendEntry({channelId, chunk})
 *    → IPC bridge to renderer → ILogFilesService.onDidAppendEntry
 *    → here: prefix each complete line with `[<channelName>] ` → append to "All"
 *
 *  chunks are not guaranteed to land on a line boundary, so we buffer the
 *  trailing partial line per channel until the next chunk completes it.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IOutputService,
  autorun,
  type IOutputChannel,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { ILogFilesService, type LogAppendEvent } from '../../shared/ipc/services.js'
import { humanizeChannelId } from '../../shared/log/logLabels.js'

export const AGGREGATED_LOG_CHANNEL_NAME = 'All'

export class AggregatedLogChannelContribution extends Disposable implements IWorkbenchContribution {
  private readonly _allChannel: IOutputChannel
  private readonly _channelIdToName = new Map<string, string>()
  private readonly _tails = new Map<string, string>()
  private _descriptorsLoaded = false
  private _refreshing = false

  constructor(
    @ILogFilesService private readonly _logFiles: ILogFilesService,
    @IOutputService output: IOutputService,
  ) {
    super()
    this._allChannel = output.createChannel(AGGREGATED_LOG_CHANNEL_NAME, 'aggregated')

    // Drop the line tail buffer whenever the user clears the All channel,
    // otherwise the next chunk would be appended onto a stale half-line.
    this._register(
      autorun((r) => {
        if (this._allChannel.content.read(r) === '') {
          this._tails.clear()
        }
      }),
    )

    void this._refreshDescriptors()
    this._register(this._logFiles.onDidAppendEntry((event) => this._handleAppend(event)))
  }

  private async _refreshDescriptors(): Promise<void> {
    if (this._refreshing) return
    this._refreshing = true
    try {
      const descriptors = await this._logFiles.listLogFiles()
      for (const d of descriptors) {
        this._channelIdToName.set(d.channelId, d.name)
      }
      this._descriptorsLoaded = true
    } catch {
      // best-effort; next append event will trigger another refresh
    } finally {
      this._refreshing = false
    }
  }

  private _handleAppend(event: LogAppendEvent): void {
    // Resolve the display name. If the channel materialized after our initial
    // listLogFiles snapshot (e.g. console.log written before the first flush)
    // fall back to humanizeChannelId so the chunk is never dropped; trigger a
    // background refresh so subsequent chunks pick up the registered name.
    let name = this._channelIdToName.get(event.channelId)
    if (name === undefined) {
      name = humanizeChannelId(event.channelId)
      this._channelIdToName.set(event.channelId, name)
      void this._refreshDescriptors()
    }

    const buf = (this._tails.get(event.channelId) ?? '') + event.chunk
    const lastNL = buf.lastIndexOf('\n')
    if (lastNL < 0) {
      this._tails.set(event.channelId, buf)
      return
    }
    const complete = buf.slice(0, lastNL + 1)
    this._tails.set(event.channelId, buf.slice(lastNL + 1))

    // complete ends in \n, so split('\n') leaves an empty trailing item — drop it.
    const lines = complete.split('\n')
    lines.pop()
    if (lines.length === 0) return
    const prefixed = lines.map((l) => `[${name}] ${l}\n`).join('')
    this._allChannel.append(prefixed)
  }

  // Test-only inspection points
  /** @internal */
  _hasLoadedDescriptors(): boolean {
    return this._descriptorsLoaded
  }
  /** @internal */
  _getTail(channelId: string): string {
    return this._tails.get(channelId) ?? ''
  }
}
