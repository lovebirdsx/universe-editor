import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  onUnexpectedError,
  setErrorTelemetryHook,
  setUnexpectedErrorHandler,
  transformErrorForSerialization,
} from '@universe-editor/platform'
import {
  BUILTIN_UNEXPECTED_ERROR_KEY,
  formatUnknownError,
  installUnexpectedErrorHandler,
} from '../errorReporter.js'

let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  setUnexpectedErrorHandler(() => {})
  setErrorTelemetryHook(() => {})
  vi.restoreAllMocks()
})

describe('installUnexpectedErrorHandler', () => {
  it('serializes and reports an error once the report is wired', () => {
    const reporter = installUnexpectedErrorHandler()
    const report = vi.fn()
    reporter.setReport(report)

    const err = new Error('boom')
    onUnexpectedError(err)

    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(transformErrorForSerialization(err))
  })

  it('only writes stderr while the channel is not ready', () => {
    installUnexpectedErrorHandler() // no setReport

    onUnexpectedError(new Error('early'))

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]?.[0]).toContain('early')
  })

  it('does not recurse when the report path re-enters onUnexpectedError', () => {
    const reporter = installUnexpectedErrorHandler()
    const report = vi.fn().mockImplementation(() => {
      onUnexpectedError(new Error('inner'))
    })
    reporter.setReport(report)

    onUnexpectedError(new Error('outer'))

    expect(report).toHaveBeenCalledOnce()
  })

  it('swallows a throwing report and logs a warning', () => {
    const reporter = installUnexpectedErrorHandler()
    reporter.setReport(() => {
      throw new Error('rpc down')
    })

    expect(() => onUnexpectedError(new Error('outer'))).not.toThrow()
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('exposes an in-process reporting entry for built-in extensions', () => {
    const reporter = installUnexpectedErrorHandler()
    const report = vi.fn()
    reporter.setReport(report)

    const entry = (globalThis as Record<string, unknown>)[BUILTIN_UNEXPECTED_ERROR_KEY] as
      | ((e: unknown) => void)
      | undefined
    expect(typeof entry).toBe('function')

    const err = new Error('lsp gone')
    entry?.(err)

    expect(report).toHaveBeenCalledWith(transformErrorForSerialization(err))
  })
})

describe('formatUnknownError', () => {
  it('prefers the stack for Error values', () => {
    const err = new Error('msg')
    expect(formatUnknownError(err)).toBe(err.stack)
  })

  it('stringifies non-Error values', () => {
    expect(formatUnknownError('plain')).toBe('plain')
  })
})
