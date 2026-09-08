/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test helper for IAcpLastSessionCwdService — wraps the real implementation
 *  against in-memory storage so tests exercise the genuine remember/probe
 *  logic without touching disk. `exists` decides what the background probe
 *  reports (default: every directory exists).
 *
 *  `stubLastSessionCwdServiceForTest()` is the zero-arg variant used by the
 *  many `new AcpSessionService(...)` call sites that don't care about cwd
 *  memory; use `stubLastSessionCwdService(...)` when a test needs to observe
 *  storage or control the probe verdict.
 *--------------------------------------------------------------------------------------------*/

import {
  Event,
  ILoggerService,
  IStorageService,
  ITelemetryService,
  IWorkspaceService,
  NullLogger,
  URI,
  type ILogger,
  type LogLevel,
} from '@universe-editor/platform'
import { AcpLastSessionCwdService, IAcpLastSessionCwdService } from '../acpLastSessionCwdService.js'

class NoopLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return 1 as LogLevel
  }
}

class MemoryStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
}

const EMPTY_WORKSPACE: IWorkspaceService = {
  _serviceBrand: undefined,
  current: null,
  whenReady: Promise.resolve(),
} as unknown as IWorkspaceService

const NOOP_TELEMETRY: ITelemetryService = {
  _serviceBrand: undefined,
  publicLog: () => {},
  publicLogError: () => {},
} as unknown as ITelemetryService

export function stubLastSessionCwdService(
  storage: IStorageService,
  workspace: IWorkspaceService,
  telemetry: ITelemetryService,
  loggerService: ILoggerService,
  exists: (uri: URI) => boolean = () => true,
): IAcpLastSessionCwdService {
  const fileService = {
    _serviceBrand: undefined,
    exists: async (uri: URI) => exists(uri),
  }
  return new AcpLastSessionCwdService(
    storage,
    workspace,
    telemetry,
    loggerService,
    fileService as never,
  )
}

export function stubLastSessionCwdServiceForTest(
  exists: (uri: URI) => boolean = () => true,
): IAcpLastSessionCwdService {
  return stubLastSessionCwdService(
    new MemoryStorage(),
    EMPTY_WORKSPACE,
    NOOP_TELEMETRY,
    new NoopLoggerService(),
    exists,
  )
}
