/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Structured error sink: folds repeated errors (fingerprint dedup, modeled on
 *  VSCode's BaseErrorTelemetry) and appends them as JSON lines to
 *  <userData>/logs/<session>/errors.jsonl. Feeds two producers through one
 *  file: renderer windows (via IPC, pre-redacted) and the main process itself
 *  (recordLocal — uncaughtException / unhandledRejection / child-process-gone).
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AggregationBuffer,
  Disposable,
  computeErrorFingerprint,
  getOriginalConsole,
  redactErrorText,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type { IErrorSinkService, WireErrorRecord } from '../../../shared/ipc/services.js'

/** One persisted line of errors.jsonl. */
export interface ErrorJsonlRecord {
  readonly v: 1
  ts: number
  readonly event: string
  readonly source: string
  readonly fingerprint: string
  count: number
  readonly message: string
  readonly stack?: string
  readonly sessionId: string
  readonly appVersion: string
  readonly dimensions?: { readonly [key: string]: string | number | boolean }
}

export interface ErrorSinkOptions {
  /** Session log directory; errors.jsonl is written at its root. */
  readonly sessionDir: string
  readonly sessionId: string
  readonly appVersion: string
  /** Absolute paths that must never land on disk (userData / userHome / appRoot / tmpDir). */
  readonly piiPaths: readonly string[]
  /** Test seam: override the output file path. */
  readonly filePath?: string
  /** Test seam: override the batch flush interval (default 5s, VSCode's ERROR_FLUSH_TIMEOUT). */
  readonly flushIntervalMs?: number
}

const DEFAULT_FLUSH_INTERVAL_MS = 5000

function redactDimensions(
  dimensions: { readonly [key: string]: string | number | boolean },
  piiPaths: readonly string[],
): { readonly [key: string]: string | number | boolean } {
  const out: { [key: string]: string | number | boolean } = {}
  for (const [k, v] of Object.entries(dimensions)) {
    out[k] = typeof v === 'string' ? redactErrorText(v, { piiPaths, maxLength: 200 }) : v
  }
  return out
}

export class ErrorSinkMainService extends Disposable implements IErrorSinkService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _filePath: string
  private readonly _flushIntervalMs: number
  private readonly _buffer: AggregationBuffer<ErrorJsonlRecord>
  private _flushTimer: ReturnType<typeof setTimeout> | null = null
  private _flushChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly _options: ErrorSinkOptions,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'errorSink', name: 'Error Sink' })
    this._filePath = _options.filePath ?? join(_options.sessionDir, 'errors.jsonl')
    this._flushIntervalMs = _options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this._buffer = new AggregationBuffer<ErrorJsonlRecord>(
      (r) => `${r.source}|${r.event}|${r.fingerprint}`,
      (existing, incoming) => {
        // Fold into the newest timestamp so reports reflect the last occurrence.
        if (incoming.ts > existing.ts) existing.ts = incoming.ts
      },
    )
  }

  /**
   * IPC entry. The producer fingerprints and dedups, but redaction is applied
   * again here: piiPaths is main-side knowledge (userData / userHome / …), so
   * the renderer ships raw text and main masks it before it touches disk.
   */
  ingestErrors(records: readonly WireErrorRecord[], source: string = 'renderer'): Promise<void> {
    const pii = { piiPaths: this._options.piiPaths }
    for (const r of records) {
      if (r.v !== 1 || typeof r.fingerprint !== 'string') continue
      const record: ErrorJsonlRecord = {
        v: 1,
        ts: r.ts,
        event: r.event,
        source,
        fingerprint: r.fingerprint,
        count: Math.max(1, r.count | 0),
        message: redactErrorText(r.message, pii),
        ...(r.stack !== undefined ? { stack: redactErrorText(r.stack, pii) } : {}),
        sessionId: r.sessionId,
        appVersion: this._options.appVersion,
        ...(r.dimensions !== undefined
          ? { dimensions: redactDimensions(r.dimensions, pii.piiPaths) }
          : {}),
      }
      this._buffer.insert(record)
    }
    this._scheduleFlush()
    return Promise.resolve()
  }

  /**
   * Main-process entry: fingerprint + redact here (renderer does the same on
   * its side with the shared platform helpers).
   */
  recordLocal(event: string, error: unknown, source = 'main'): void {
    const rawStack = error instanceof Error ? error.stack : undefined
    const rawMessage = error instanceof Error ? error.message : String(error)
    const fingerprint = computeErrorFingerprint(rawStack, rawMessage)
    const pii = { piiPaths: this._options.piiPaths }
    const record: ErrorJsonlRecord = {
      v: 1,
      ts: Date.now(),
      event,
      source,
      fingerprint,
      count: 1,
      message: redactErrorText(rawMessage.split('\n', 1)[0] ?? rawMessage, pii),
      ...(rawStack !== undefined ? { stack: redactErrorText(rawStack, pii) } : {}),
      sessionId: this._options.sessionId,
      appVersion: this._options.appVersion,
    }
    this._buffer.insert(record)
    this._scheduleFlush()
  }

  flush(): Promise<void> {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._flushChain = this._flushChain.then(() => this._flushNow())
    return this._flushChain
  }

  private _scheduleFlush(): void {
    if (this._flushTimer !== null) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      void this.flush()
    }, this._flushIntervalMs)
  }

  private async _flushNow(): Promise<void> {
    const drained = this._buffer.flush()
    if (drained.length === 0) return
    const content = drained.map((r) => JSON.stringify(r)).join('\n') + '\n'
    try {
      await fs.mkdir(dirname(this._filePath), { recursive: true })
      await fs.appendFile(this._filePath, content, 'utf8')
    } catch (err) {
      // Never recurse through the console interceptor — same rule as FileLogger.
      getOriginalConsole().error('[ErrorSink] Failed to write errors.jsonl:', err)
    }
  }

  /** Debug/inspection: current dedup state without draining. */
  describePending(): string {
    return `errorSink pending=${this._buffer.size} file=${this._filePath}`
  }

  override dispose(): void {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    void this.flush()
    super.dispose()
  }
}

/**
 * Per-window wrapper: stamps the authoritative source (`renderer:<windowId>`)
 * so a renderer cannot forge another window's records — same pattern as
 * createWindowScopedUpdateService.
 */
export function createWindowScopedErrorSink(
  sink: ErrorSinkMainService,
  windowId: number,
): IErrorSinkService {
  return {
    _serviceBrand: undefined,
    ingestErrors: (records) => sink.ingestErrors(records, `renderer:${windowId}`),
  }
}
