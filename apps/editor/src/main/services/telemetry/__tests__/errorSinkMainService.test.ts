/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/telemetry/errorSinkMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ErrorSinkMainService,
  createWindowScopedErrorSink,
  type ErrorJsonlRecord,
} from '../errorSinkMainService.js'
import type { WireErrorRecord } from '../../../../shared/ipc/services.js'

function makeError(message: string, frameFile = 'D:\\app\\src\\thing\\doer.ts', line = 10): Error {
  const err = new Error(message)
  err.stack = `Error: ${message}\n    at run (${frameFile}:${line}:5)`
  return err
}

function wireRecord(overrides: Partial<WireErrorRecord> = {}): WireErrorRecord {
  return {
    v: 1,
    ts: 1700000000000,
    event: 'unhandledError',
    fingerprint: 'run@thing/doer.ts',
    count: 1,
    message: 'boom',
    sessionId: 'renderer-session-x',
    ...overrides,
  }
}

describe('ErrorSinkMainService', () => {
  let dir: string
  let filePath: string
  let sink: ErrorSinkMainService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'error-sink-test-'))
    filePath = join(dir, 'errors.jsonl')
    sink = new ErrorSinkMainService({
      sessionDir: dir,
      sessionId: '20260804T000000',
      appVersion: '0.0.0-test',
      piiPaths: ['D:\\app'],
      filePath,
    })
  })

  afterEach(() => {
    sink.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  function readRecords(): ErrorJsonlRecord[] {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ErrorJsonlRecord)
  }

  it('folds repeated local errors into one line with a count', async () => {
    sink.recordLocal('unhandledError', makeError('boom'))
    sink.recordLocal('unhandledError', makeError('boom'))
    sink.recordLocal('unhandledError', makeError('boom'))
    await sink.flush()
    const records = readRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      v: 1,
      event: 'unhandledError',
      source: 'main',
      fingerprint: 'run@thing/doer.ts',
      count: 3,
      message: 'boom',
      sessionId: '20260804T000000',
      appVersion: '0.0.0-test',
    })
  })

  it('keeps distinct events / fingerprints as separate lines', async () => {
    sink.recordLocal('unhandledError', makeError('boom'))
    sink.recordLocal('uncaughtException', makeError('boom'))
    sink.recordLocal('unhandledError', makeError('other', 'D:\\app\\src\\other\\fail.ts'))
    await sink.flush()
    expect(readRecords()).toHaveLength(3)
  })

  it('redacts pii paths from message and stack', async () => {
    sink.recordLocal('unhandledError', makeError("ENOENT: open 'D:\\app\\secret\\x.txt'"))
    await sink.flush()
    const [r] = readRecords()
    expect(r?.message).not.toContain('D:\\app')
    expect(r?.stack).not.toContain('D:\\app')
    expect(r?.stack).toContain('doer.ts')
  })

  it('ingests renderer records with the caller-stamped source', async () => {
    await sink.ingestErrors([wireRecord(), wireRecord()], 'renderer:7')
    await sink.flush()
    const records = readRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ source: 'renderer:7', count: 2 })
    // appVersion is stamped by main, never taken from the wire.
    expect(records[0]?.appVersion).toBe('0.0.0-test')
  })

  it('window-scoped wrapper stamps renderer:<id> authoritatively', async () => {
    const scoped = createWindowScopedErrorSink(sink, 42)
    await scoped.ingestErrors([wireRecord()])
    await sink.flush()
    expect(readRecords()[0]?.source).toBe('renderer:42')
  })

  it('skips malformed wire records without throwing', async () => {
    await sink.ingestErrors([
      { ...wireRecord(), v: 2 as never },
      { ...wireRecord(), fingerprint: undefined as never },
      wireRecord(),
    ])
    await sink.flush()
    expect(readRecords()).toHaveLength(1)
  })

  it('flushes automatically after the interval', async () => {
    vi.useFakeTimers()
    try {
      const auto = new ErrorSinkMainService({
        sessionDir: dir,
        sessionId: 's',
        appVersion: '0',
        piiPaths: [],
        filePath: join(dir, 'auto.jsonl'),
        flushIntervalMs: 50,
      })
      auto.recordLocal('unhandledError', makeError('auto'))
      await vi.advanceTimersByTimeAsync(60)
      // flush chain is async; let it settle
      await vi.waitFor(() => {
        expect(readFileSync(join(dir, 'auto.jsonl'), 'utf8')).toContain('auto')
      })
      auto.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose flushes pending records', async () => {
    sink.recordLocal('unhandledError', makeError('bye'))
    sink.dispose()
    // dispose triggers an async flush; wait for the file to appear
    await vi.waitFor(() => {
      expect(readRecords().some((r) => r.message === 'bye')).toBe(true)
    })
  })

  it('never throws when the output path is unwritable', async () => {
    const broken = new ErrorSinkMainService({
      sessionDir: dir,
      sessionId: 's',
      appVersion: '0',
      piiPaths: [],
      filePath: join(dir, 'missing-parent', 'nested', 'x', 'errors.jsonl\x00'),
    })
    broken.recordLocal('unhandledError', makeError('boom'))
    await expect(broken.flush()).resolves.toBeUndefined()
    broken.dispose()
  })
})
