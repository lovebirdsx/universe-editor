/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/log/log.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  AbstractLogger,
  canLog,
  ConsoleLogger,
  LogLevel,
  MultiplexLogger,
  NullLogger,
} from '../../log/log.js'

describe('canLog', () => {
  it('returns false when level is Off', () => {
    const logger = new NullLogger(LogLevel.Off)
    expect(canLog(logger, LogLevel.Error)).toBe(false)
  })

  it('returns true when message level >= logger level', () => {
    const logger = new NullLogger(LogLevel.Info)
    expect(canLog(logger, LogLevel.Info)).toBe(true)
    expect(canLog(logger, LogLevel.Warning)).toBe(true)
    expect(canLog(logger, LogLevel.Error)).toBe(true)
  })

  it('returns false when message level < logger level', () => {
    const logger = new NullLogger(LogLevel.Warning)
    expect(canLog(logger, LogLevel.Info)).toBe(false)
    expect(canLog(logger, LogLevel.Debug)).toBe(false)
  })
})

describe('NullLogger', () => {
  it('does not throw on any level', () => {
    const log = new NullLogger()
    expect(() => {
      log.trace('t')
      log.debug('d')
      log.info('i')
      log.warn('w')
      log.error('e')
      log.flush()
      log.dispose()
    }).not.toThrow()
  })
})

describe('AbstractLogger level check', () => {
  it('does not call _log when below level', () => {
    const messages: string[] = []
    class TestLogger extends AbstractLogger {
      protected _log(_level: LogLevel, message: string): void {
        messages.push(message)
      }
    }
    const log = new TestLogger(LogLevel.Warning)
    log.debug('should not appear')
    log.info('should not appear')
    log.warn('should appear')
    expect(messages).toEqual(['should appear'])
  })

  it('setLevel changes filtering threshold', () => {
    const messages: string[] = []
    class TestLogger extends AbstractLogger {
      protected _log(_level: LogLevel, message: string): void {
        messages.push(message)
      }
    }
    const log = new TestLogger(LogLevel.Warning)
    log.info('before')
    log.setLevel(LogLevel.Debug)
    log.info('after')
    expect(messages).toEqual(['after'])
  })
})

describe('ConsoleLogger', () => {
  it('calls console.info for Info level', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = new ConsoleLogger(LogLevel.Info)
    log.info('hello')
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]?.[0]).toContain('hello')
    spy.mockRestore()
  })

  it('calls console.error for Error level', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = new ConsoleLogger(LogLevel.Info)
    log.error('boom')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('does not call console when level is Off', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = new ConsoleLogger(LogLevel.Off)
    log.info('should not log')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('MultiplexLogger', () => {
  it('forwards to all delegates', () => {
    const messages1: string[] = []
    const messages2: string[] = []

    class CapturingLogger extends AbstractLogger {
      constructor(
        level: LogLevel,
        private readonly _out: string[],
      ) {
        super(level)
      }
      protected _log(_level: LogLevel, message: string): void {
        this._out.push(message)
      }
    }

    const l1 = new CapturingLogger(LogLevel.Info, messages1)
    const l2 = new CapturingLogger(LogLevel.Info, messages2)
    const multi = new MultiplexLogger([l1, l2], LogLevel.Info)

    multi.info('hello')
    expect(messages1).toContain('hello')
    expect(messages2).toContain('hello')
  })

  it('does not forward below level', () => {
    const messages: string[] = []

    class CapturingLogger extends AbstractLogger {
      constructor(
        level: LogLevel,
        private readonly _out: string[],
      ) {
        super(level)
      }
      protected _log(_level: LogLevel, msg: string): void {
        this._out.push(msg)
      }
    }

    const l = new CapturingLogger(LogLevel.Warning, messages)
    const multi = new MultiplexLogger([l], LogLevel.Warning)

    multi.debug('debug')
    multi.info('info')
    expect(messages).toHaveLength(0)

    multi.warn('warn')
    expect(messages).toHaveLength(1)
  })

  it('propagates setLevel to all delegates', () => {
    const log = new NullLogger(LogLevel.Info)
    const multi = new MultiplexLogger([log], LogLevel.Info)
    multi.setLevel(LogLevel.Debug)
    expect(log.level).toBe(LogLevel.Debug)
  })
})
