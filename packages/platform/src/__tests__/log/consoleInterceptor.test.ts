/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/log/consoleInterceptor.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installConsoleInterceptor } from '../../log/consoleInterceptor.js'
import { AbstractLogger, LogLevel, getOriginalConsole, type ILogger } from '../../log/log.js'

class RecordingLogger extends AbstractLogger {
  readonly entries: { level: LogLevel; message: string }[] = []
  constructor(level: LogLevel = LogLevel.Trace) {
    super(level)
  }
  protected _log(level: LogLevel, message: string): void {
    this.entries.push({ level, message })
  }
}

describe('installConsoleInterceptor', () => {
  const before: Partial<Console> = {}
  beforeEach(() => {
    before.log = console.log
    before.info = console.info
    before.warn = console.warn
    before.error = console.error
    before.debug = console.debug
    before.trace = console.trace
  })
  afterEach(() => {
    Object.assign(console, before)
  })

  it('routes each console method to the matching logger level', () => {
    const logger = new RecordingLogger()
    // Suppress real console noise BEFORE install so the interceptor's closure
    // captures the spy (otherwise it would call through to real stdout).
    vi.spyOn(getOriginalConsole(), 'log').mockImplementation(() => {})
    vi.spyOn(getOriginalConsole(), 'info').mockImplementation(() => {})
    vi.spyOn(getOriginalConsole(), 'warn').mockImplementation(() => {})
    vi.spyOn(getOriginalConsole(), 'error').mockImplementation(() => {})
    vi.spyOn(getOriginalConsole(), 'debug').mockImplementation(() => {})
    vi.spyOn(getOriginalConsole(), 'trace').mockImplementation(() => {})
    const disposable = installConsoleInterceptor({ logger })

    try {
      console.log('hello', 1)
      console.info('world')
      console.warn('warn-me')
      console.error('boom')
      console.debug('debug-me')
      console.trace('trace-me')
    } finally {
      disposable.dispose()
      vi.restoreAllMocks()
    }

    const seen = logger.entries.map((e) => [e.level, e.message] as const)
    expect(seen).toEqual([
      [LogLevel.Info, 'hello 1'],
      [LogLevel.Info, 'world'],
      [LogLevel.Warning, 'warn-me'],
      [LogLevel.Error, 'boom'],
      [LogLevel.Debug, 'debug-me'],
      [LogLevel.Trace, 'trace-me'],
    ])
  })

  it('does not recurse when the logger itself calls console.* synchronously', () => {
    const reentryCounter = { count: 0 }
    const trippy: ILogger = {
      level: LogLevel.Trace,
      onDidChangeLogLevel: () => ({ dispose() {} }),
      setLevel() {},
      trace() {},
      debug() {},
      info(msg: string) {
        reentryCounter.count += 1
        console.error('recursion-canary: ' + msg)
      },
      warn() {},
      error() {},
      flush() {},
      dispose() {},
    }
    vi.spyOn(getOriginalConsole(), 'error').mockImplementation(() => {})
    vi.spyOn(getOriginalConsole(), 'log').mockImplementation(() => {})
    const disposable = installConsoleInterceptor({ logger: trippy })
    try {
      console.log('one')
    } finally {
      disposable.dispose()
      vi.restoreAllMocks()
    }
    expect(reentryCounter.count).toBe(1)
  })

  it('still forwards to the original console (DevTools / stdout) on every call', () => {
    const logger = new RecordingLogger()
    // Swap the property BEFORE installing — the interceptor reads
    // getOriginalConsole().log into its closure at install time.
    const realLog = getOriginalConsole().log
    const fakeLog = vi.fn()
    ;(getOriginalConsole() as unknown as Record<string, unknown>)['log'] = fakeLog
    const disposable = installConsoleInterceptor({ logger })
    try {
      console.log('visible-in-devtools')
    } finally {
      disposable.dispose()
      ;(getOriginalConsole() as unknown as Record<string, unknown>)['log'] = realLog
    }
    expect(fakeLog).toHaveBeenCalledWith('visible-in-devtools')
  })

  it('dispose restores the previous console methods', () => {
    const logger = new RecordingLogger()
    const originalLog = console.log
    const disposable = installConsoleInterceptor({ logger })
    expect(console.log).not.toBe(originalLog)
    disposable.dispose()
    expect(console.log).toBe(originalLog)
  })

  it('swallows logger throws so the host program keeps working', () => {
    const angry: ILogger = {
      level: LogLevel.Trace,
      onDidChangeLogLevel: () => ({ dispose() {} }),
      setLevel() {},
      trace() {},
      debug() {},
      info() {
        throw new Error('logger boom')
      },
      warn() {},
      error() {},
      flush() {},
      dispose() {},
    }
    vi.spyOn(getOriginalConsole(), 'log').mockImplementation(() => {})
    const disposable = installConsoleInterceptor({ logger: angry })
    try {
      expect(() => console.log('still works')).not.toThrow()
    } finally {
      disposable.dispose()
      vi.restoreAllMocks()
    }
  })
})

describe('getOriginalConsole', () => {
  it('returns the same snapshot regardless of patching', () => {
    const snapshot = getOriginalConsole()
    const logger = new RecordingLogger()
    const disposable = installConsoleInterceptor({ logger })
    try {
      expect(getOriginalConsole()).toBe(snapshot)
      // The snapshot's log is the pre-patch one, not the live console.log.
      expect(getOriginalConsole().log).not.toBe(console.log)
    } finally {
      disposable.dispose()
    }
  })
})
