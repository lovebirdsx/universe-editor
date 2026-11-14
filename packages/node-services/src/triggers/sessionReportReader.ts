/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads one trigger run's report.md for the phone gateway, the desktop report
 *  tab and the remote server's `triggerPoll.readReport`.
 *
 *  The caller supplies only a run id resolved from server-owned session
 *  metadata. The file name is fixed, the path is rebuilt from the configured
 *  runs root and re-checked after realpath so a symlinked run directory or
 *  report file cannot escape it. Client-supplied paths never reach this class.
 *--------------------------------------------------------------------------------------------*/

import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  arePathsEqual,
  normalizePlatform,
  relativePathUnder,
  type ILogger,
} from '@universe-editor/platform'
import { isValidTriggerRunId } from './triggerProtocol.js'

export const SESSION_REPORT_FILE_NAME = 'report.md'
/** Same cap the phone gateway and the desktop report tab enforce (512 KiB). */
export const DEFAULT_SESSION_REPORT_MAX_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export type SessionReportReadResult =
  | {
      readonly ok: true
      readonly bytes: Uint8Array
      /** Resolved run directory (the report's base URI for relative resources). */
      readonly runDir: string
      /** Report file mtime; the closest thing to the run's completion time. */
      readonly modifiedAt: number
    }
  | { readonly ok: false; readonly reason: 'not_found' | 'too_large' }

export interface SessionReportReaderOptions {
  /** Runs root; every run id must resolve to a direct child of it. */
  readonly runsDir: string
  readonly maxBytes?: number
  readonly timeoutMs?: number
  readonly logger: Pick<ILogger, 'warn'>
}

export class SessionReportReader {
  private readonly _runsDir: string
  private readonly _maxBytes: number
  private readonly _timeoutMs: number
  private readonly _logger: Pick<ILogger, 'warn'>
  private readonly _platform = normalizePlatform(process.platform)

  constructor(options: SessionReportReaderOptions) {
    this._runsDir = options.runsDir
    this._maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_SESSION_REPORT_MAX_BYTES)
    this._timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this._logger = options.logger
  }

  async read(runId: string): Promise<SessionReportReadResult> {
    if (!isValidTriggerRunId(runId)) return notFound()
    try {
      return await withTimeout(this._read(runId), this._timeoutMs)
    } catch (err) {
      this._logger.warn(`session report read failed: ${describeError(err)}`)
      return notFound()
    }
  }

  private async _read(runId: string): Promise<SessionReportReadResult> {
    const runsRoot = await realpath(this._runsDir)
    const expectedRunDir = join(runsRoot, runId)
    const runDir = await realpath(expectedRunDir)
    if (!arePathsEqual(runDir, expectedRunDir, this._platform)) return notFound()

    const reportPath = join(runDir, SESSION_REPORT_FILE_NAME)
    const link = await lstat(reportPath)
    if (link.isSymbolicLink() || !link.isFile()) return notFound()
    if (link.size > this._maxBytes) return { ok: false, reason: 'too_large' }

    const report = await readFile(reportPath)
    if (report.byteLength > this._maxBytes) return { ok: false, reason: 'too_large' }
    if (relativePathUnder(runDir, reportPath, this._platform) !== SESSION_REPORT_FILE_NAME) {
      return notFound()
    }
    const file = await stat(reportPath)
    if (!file.isFile()) return notFound()
    return { ok: true, bytes: report, runDir, modifiedAt: file.mtimeMs }
  }
}

function notFound(): SessionReportReadResult {
  return { ok: false, reason: 'not_found' }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`session report read timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code === undefined ? err.message : `${code}: ${err.message}`
  }
  return String(err)
}
