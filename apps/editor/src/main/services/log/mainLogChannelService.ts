/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IPC receiver: renderer windows send log entries here via ProxyChannel.
 *  Routes each entry to the per-channel logger in LogMainService. Renderer logs
 *  land in this window's private `window-<id>/${channel}.log` (separate from
 *  main-process channels), tagged so only this window's Output panel shows them.
 *  Provenance is the authoritative BrowserWindow id, not the renderer-supplied
 *  value, so the `[renderer:<id>]` prefix and routing can never be spoofed.
 *--------------------------------------------------------------------------------------------*/

import { LogLevel } from '@universe-editor/platform'
import type { ILogChannelService, LogEntry } from '../../../shared/ipc/services.js'
import type { LogMainService } from './logMainService.js'
import { humanizeChannelId } from '../../../shared/log/logLabels.js'

export class MainLogChannelService implements ILogChannelService {
  declare readonly _serviceBrand: undefined

  constructor(
    private readonly _logService: LogMainService,
    private readonly _windowId: number,
  ) {}

  async append(
    channel: string,
    level: LogLevel,
    message: string,
    timestamp: number = Date.now(),
  ): Promise<void> {
    this._write(channel, level, message, timestamp)
  }

  async appendBatch(entries: readonly LogEntry[]): Promise<void> {
    for (const entry of entries) {
      this._write(entry.channel, entry.level, entry.message, entry.timestamp)
    }
  }

  private _write(channelId: string, level: LogLevel, message: string, timestamp: number): void {
    const channel = {
      id: channelId,
      name: this._logService.getChannel(channelId)?.name ?? humanizeChannelId(channelId),
    }
    this._logService.appendToChannel(
      channel,
      level,
      `[renderer:${this._windowId}] ${message}`,
      timestamp,
      this._windowId,
    )
  }
}
