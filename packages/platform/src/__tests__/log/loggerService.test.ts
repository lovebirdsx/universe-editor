/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/log/loggerService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ILoggerService, type ILogChannel } from '../../log/loggerService.js'
import { NullLogger, LogLevel, type ILogger } from '../../log/log.js'
import type { ILoggerService as ILoggerServiceType } from '../../log/loggerService.js'

describe('ILoggerService decorator', () => {
  it('has service id "loggerService"', () => {
    expect(ILoggerService.toString()).toBe('loggerService')
  })
})

describe('ILogChannel', () => {
  it('channel object with id and name satisfies ILogChannel', () => {
    const channel: ILogChannel = { id: 'main', name: 'Main' }
    expect(channel.id).toBe('main')
    expect(channel.name).toBe('Main')
  })
})

describe('ILoggerService contract', () => {
  it('mock implementation: createLogger returns ILogger per channel', () => {
    const loggers = new Map<string, ILogger>()
    const mock: ILoggerServiceType & { _serviceBrand: undefined } = {
      _serviceBrand: undefined as never,
      createLogger(channel: ILogChannel): ILogger {
        let l = loggers.get(channel.id)
        if (!l) {
          l = new NullLogger()
          loggers.set(channel.id, l)
        }
        return l
      },
      setLevel(_level: LogLevel): void {},
      getLevel(): LogLevel {
        return LogLevel.Info
      },
    }

    const a = mock.createLogger({ id: 'a', name: 'A' })
    const b = mock.createLogger({ id: 'b', name: 'B' })
    const a2 = mock.createLogger({ id: 'a', name: 'A' })

    expect(a).toBe(a2)
    expect(a).not.toBe(b)
  })
})
