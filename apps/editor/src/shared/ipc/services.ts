/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contracts for editor-specific cross-process services. Generic services
 *  (host, storage) live in @universe-editor/platform; this file holds only the
 *  app-local additions. Both main (server) and renderer (client via ProxyChannel)
 *  import these symbols so the channel surface stays in lock-step at the type
 *  level.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { LogLevel } from '@universe-editor/platform'

// -------- Ping (demo/smoke-test) --------

export interface PingResult {
  pong: true
  rendererSentAt: number
  mainReceivedAt: number
}

export interface IPingService {
  readonly _serviceBrand: undefined
  ping(rendererSentAt: number): Promise<PingResult>
}

export const IPingService = createDecorator<IPingService>('pingService')

// -------- Log Channel (renderer → main aggregation) --------

/**
 * Wire-only IPC contract for renderer-side logging.
 * Each renderer window sends structured log entries; the main process writes them to disk.
 */
export interface ILogChannelService {
  readonly _serviceBrand: undefined
  append(windowId: number, channel: string, level: LogLevel, message: string): Promise<void>
}

export const ILogChannelService = createDecorator<ILogChannelService>('logChannelService')
