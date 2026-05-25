/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/log/log.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  AbstractLogger,
  canLog,
  ConsoleLogger,
  getOriginalConsole,
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
  it('calls the captured console.info for Info level', () => {
    const spy = vi.spyOn(getOriginalConsole(), 'info').mockImplementation(() => {})
    const log = new ConsoleLogger(LogLevel.Info)
    log.info('hello')
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]?.[0]).toContain('hello')
    spy.mockRestore()
  })

  it('calls the captured console.error for Error level', () => {
    const spy = vi.spyOn(getOriginalConsole(), 'error').mockImplementation(() => {})
    const log = new ConsoleLogger(LogLevel.Info)
    log.error('boom')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('does not call console when level is Off', () => {
    const spy = vi.spyOn(getOriginalConsole(), 'info').mockImplementation(() => {})
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

describe('AbstractLogger.onDidChangeLogLevel', () => {
  it('fires when setLevel changes the level', () => {
    const log = new NullLogger(LogLevel.Info)
    const seen: LogLevel[] = []
    log.onDidChangeLogLevel((level) => seen.push(level))
    log.setLevel(LogLevel.Debug)
    expect(seen).toEqual([LogLevel.Debug])
  })

  it('does not fire when setLevel is called with the same level', () => {
    const log = new NullLogger(LogLevel.Info)
    const seen: LogLevel[] = []
    log.onDidChangeLogLevel((level) => seen.push(level))
    log.setLevel(LogLevel.Info)
    expect(seen).toEqual([])
  })

  it('MultiplexLogger.setLevel triggers events on every delegate', () => {
    const a = new NullLogger(LogLevel.Info)
    const b = new NullLogger(LogLevel.Info)
    const mux = new MultiplexLogger([a, b], LogLevel.Info)
    const seenA: LogLevel[] = []
    const seenB: LogLevel[] = []
    a.onDidChangeLogLevel((level) => seenA.push(level))
    b.onDidChangeLogLevel((level) => seenB.push(level))
    mux.setLevel(LogLevel.Error)
    expect(seenA).toEqual([LogLevel.Error])
    expect(seenB).toEqual([LogLevel.Error])
  })
})

describe('AbstractLogger formatArgs', () => {
  class CapturingLogger extends AbstractLogger {
    readonly entries: string[] = []
    protected _log(_level: LogLevel, message: string): void {
      this.entries.push(message)
    }
  }

  it('stringifies plain objects as JSON', () => {
    const log = new CapturingLogger(LogLevel.Info)
    log.info('payload', { a: 1, b: 'two' })
    expect(log.entries[0]).toBe('payload {"a":1,"b":"two"}')
  })

  it('emits Error stack/message instead of "[object Object]"', () => {
    const log = new CapturingLogger(LogLevel.Info)
    const err = new Error('boom')
    log.error('failed', err)
    expect(log.entries[0]).toContain(err.stack ?? err.message)
  })
})
