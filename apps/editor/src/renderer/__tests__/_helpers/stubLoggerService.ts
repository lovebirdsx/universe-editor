/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Stub ILoggerService for tests: hands out NullLogger, so anything the SUT logs
 *  goes nowhere. `implements ILoggerService` is the point of this file — a
 *  hand-rolled object literal cast to the interface (`as unknown as ILoggerService`)
 *  compiles while the interface drifts, and only fails at runtime, inside
 *  `createNamedLogger`, as `service?.createLogger is not a function`.
 *--------------------------------------------------------------------------------------------*/

import { LogLevel, NullLogger, type ILogger, type ILoggerService } from '@universe-editor/platform'

export class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}
