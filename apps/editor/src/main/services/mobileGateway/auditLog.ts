/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Append-only audit trail at `<userData>/mobile/audit.jsonl`. Rotates to
 *  `audit.jsonl.1` once the current file reaches the size cap. Callers must
 *  never pass a pairing code or bearer token: entries carry device identity,
 *  remote address, action and result only.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export const AUDIT_ROTATE_BYTES = 1024 * 1024

export interface AuditEntry {
  readonly ts: number
  readonly deviceId?: string
  readonly deviceName?: string
  readonly remoteAddress?: string
  readonly action: string
  readonly result: 'success' | 'failure'
  readonly detail?: string
}

export type AuditInput = Omit<AuditEntry, 'ts'> & { readonly ts?: number }

export interface AuditLogOptions {
  readonly now?: () => number
  readonly maxBytes?: number
}

export class AuditLog {
  private readonly _now: () => number
  private readonly _maxBytes: number
  private _queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly _file: string,
    options: AuditLogOptions = {},
  ) {
    this._now = options.now ?? Date.now
    this._maxBytes = options.maxBytes ?? AUDIT_ROTATE_BYTES
  }

  append(input: AuditInput): Promise<void> {
    return this._enqueue(async () => {
      const entry: AuditEntry = { ...input, ts: input.ts ?? this._now() }
      const line = `${JSON.stringify(entry)}\n`
      await mkdir(dirname(this._file), { recursive: true })
      await this._rotateIfNeeded(Buffer.byteLength(line))
      await appendFile(this._file, line, { encoding: 'utf8', mode: 0o600 })
    })
  }

  /** Newest `limit` entries, oldest first. Malformed lines are skipped. */
  recent(limit: number): Promise<AuditEntry[]> {
    return this._enqueue(async () => {
      const max = Math.max(1, Math.floor(limit))
      const lines: string[] = []
      for (const file of [`${this._file}.1`, this._file]) {
        try {
          lines.push(...(await readFile(file, 'utf8')).split('\n'))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }
      const entries: AuditEntry[] = []
      for (const line of lines) {
        if (line.trim() === '') continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (isAuditEntry(parsed)) entries.push(parsed)
        } catch {
          // A torn final line after a crash is not an audit failure.
        }
      }
      return entries.slice(-max)
    })
  }

  private async _rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size = 0
    try {
      size = (await stat(this._file)).size
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return
    }
    if (size === 0 || size + incomingBytes <= this._maxBytes) return
    const rotated = `${this._file}.1`
    await rm(rotated, { force: true })
    await rename(this._file, rotated)
  }

  private _enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this._queue.then(task, task)
    this._queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['ts'] === 'number' &&
    typeof record['action'] === 'string' &&
    (record['result'] === 'success' || record['result'] === 'failure')
  )
}
