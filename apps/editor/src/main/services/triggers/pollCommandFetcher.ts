/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Poll source data acquisition: run the user's command through a shell in the
 *  trigger's workspace and normalize its stdout into dedupe keys + scalar payloads.
 *  Never logs or returns raw output beyond the normalized payload (which only ever
 *  reaches the prompt), so a failing command cannot leak data into logs/audit.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'node:child_process'
import { localize, type ILogger } from '@universe-editor/platform'
import type { TriggerPayloadValue } from '../../../shared/triggers/types.js'

export const POLL_MAX_STDOUT_BYTES = 1024 * 1024
export const POLL_MAX_PAYLOAD_VALUE_LENGTH = 4000

export interface PollFetchRequest {
  readonly command: string
  /** Absolute workspace folder; the command runs with it as cwd. */
  readonly cwd: string
  readonly timeoutSec: number
  readonly keyField: string
}

export interface PollItem {
  /** Raw value of `keyField`; TriggerMainService prefixes it with `poll:`. */
  readonly key: string
  readonly payload: Readonly<Record<string, TriggerPayloadValue>>
}

export type PollFetchResult =
  | { readonly ok: true; readonly items: readonly PollItem[] }
  | { readonly ok: false; readonly error: string }

export type PollCommandFetcher = (request: PollFetchRequest) => Promise<PollFetchResult>

/** Scalar-only payload; nested values are stringified and truncated. */
export function toPayloadValue(value: unknown): TriggerPayloadValue | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value === null || value === undefined) return undefined
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return undefined
  }
  if (json === undefined) return undefined
  return json.slice(0, POLL_MAX_PAYLOAD_VALUE_LENGTH)
}

function normalizeItem(
  entry: unknown,
  keyField: string,
  logger: ILogger | undefined,
): PollItem | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    logger?.warn('poll: skipped a non-object item')
    return undefined
  }
  const record = entry as Record<string, unknown>
  const keyValue = record[keyField]
  if (typeof keyValue !== 'string' && typeof keyValue !== 'number') {
    logger?.warn(`poll: skipped an item without a string/number "${keyField}"`)
    return undefined
  }
  const key = String(keyValue)
  if (key.length === 0) {
    logger?.warn(`poll: skipped an item with an empty "${keyField}"`)
    return undefined
  }
  const payload: Record<string, TriggerPayloadValue> = {}
  for (const field of Object.keys(record)) {
    const value = toPayloadValue(record[field])
    if (value !== undefined) payload[field] = value
  }
  return { key, payload }
}

/** Accepts a JSON array or `{ "items": [...] }`; anything else is an error. */
export function parsePollStdout(
  stdout: string,
  keyField: string,
  logger?: ILogger,
): PollFetchResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {
      ok: false,
      error: localize(
        'triggers.error.pollInvalidJson',
        'The poll command did not print valid JSON',
      ),
    }
  }
  const rawItems = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : undefined
  if (rawItems === undefined) {
    return {
      ok: false,
      error: localize(
        'triggers.error.pollShape',
        'The poll command must print a JSON array or an object with an "items" array',
      ),
    }
  }
  const items: PollItem[] = []
  for (const entry of rawItems) {
    const item = normalizeItem(entry, keyField, logger)
    if (item !== undefined) items.push(item)
  }
  return { ok: true, items }
}

interface ExecFailure {
  readonly killed?: boolean
  readonly code?: string | number
  readonly signal?: string | null
}

export function describePollExecError(err: ExecFailure, timeoutSec: number): string {
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return localize(
      'triggers.error.pollTooLarge',
      'The poll command printed more than 1 MB and was stopped',
    )
  }
  if (err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
    return localize('triggers.error.pollTimeout', 'The poll command timed out after {seconds}s', {
      seconds: timeoutSec,
    })
  }
  const code = typeof err.code === 'number' ? err.code : undefined
  return code === undefined
    ? localize('triggers.error.pollCommandStart', 'The poll command could not be started')
    : localize('triggers.error.pollCommandExit', 'The poll command exited with code {code}', {
        code,
      })
}

/** Default fetcher: `exec` (shell), workspace cwd, hard timeout, 1 MB stdout cap. */
export function createPollCommandFetcher(logger?: ILogger): PollCommandFetcher {
  return (request) =>
    new Promise<PollFetchResult>((resolve) => {
      exec(
        request.command,
        {
          cwd: request.cwd,
          timeout: request.timeoutSec * 1000,
          maxBuffer: POLL_MAX_STDOUT_BYTES,
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout) => {
          if (err) {
            resolve({ ok: false, error: describePollExecError(err, request.timeoutSec) })
            return
          }
          resolve(
            parsePollStdout(typeof stdout === 'string' ? stdout : '', request.keyField, logger),
          )
        },
      )
    })
}
