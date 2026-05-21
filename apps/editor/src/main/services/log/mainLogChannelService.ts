/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IPC receiver: renderer windows send log entries here via ProxyChannel.
 *  Routes each entry to the per-channel logger in LogMainService so that
 *  renderer-side logs land in the same `${channel}.log` files as main-side logs,
 *  with `[renderer:<windowId>]` prefix marking provenance.
 *--------------------------------------------------------------------------------------------*/

import { LogLevel } from '@universe-editor/platform'
import type { ILogChannelService, LogEntry } from '../../../shared/ipc/services.js'
import type { LogMainService } from './logMainService.js'
import { humanizeChannelId } from './logLabels.js'

export class MainLogChannelService implements ILogChannelService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _logService: LogMainService) {}

  async append(
    windowId: number,
    channel: string,
    level: LogLevel,
    message: string,
    timestamp: number = Date.now(),
  ): Promise<void> {
    this._write(windowId, channel, level, message, timestamp)
  }

  async appendBatch(windowId: number, entries: readonly LogEntry[]): Promise<void> {
    for (const entry of entries) {
      this._write(windowId, entry.channel, entry.level, entry.message, entry.timestamp)
    }
  }

  private _write(
    windowId: number,
    channelId: string,
    level: LogLevel,
    message: string,
    timestamp: number,
  ): void {
    const channel = {
      id: channelId,
      name: this._logService.getChannel(channelId)?.name ?? humanizeChannelId(channelId),
    }
    this._logService.appendToChannel(channel, level, `[renderer:${windowId}] ${message}`, timestamp)
  }
}
