/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Poll source data acquisition: run the user's command through a shell in the
 *  trigger's workspace and normalize its stdout into dedupe keys + scalar payloads.
 *  Never logs or returns raw output beyond the normalized payload (which only ever
 *  reaches the prompt), so a failing command cannot leak data into logs/audit.
 *
 *  Shared by the editor's main process (local workspaces) and the remote server
 *  (remote workspaces); callers own the cwd. The `cwd` here is always a
 *  host-native path of the machine that runs the command.
 *--------------------------------------------------------------------------------------------*/

import { spawn, spawnSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { localize, type ILogger } from '@universe-editor/platform'
import { ManagedChildProcess, type TreeKiller } from '../process/managedChildProcess.js'
import {
  APP_OWNER,
  processGroupSpawnOptions,
  type ProcessLifecycleRegistry,
  type ProcessOwner,
} from '../process/processLifecycle.js'
import type { TriggerPayloadValue, TriggerPollItem, TriggerPollResult } from './triggerProtocol.js'

export const POLL_MAX_STDOUT_BYTES = 1024 * 1024
export const POLL_MAX_PAYLOAD_VALUE_LENGTH = 4000

export interface PollFetchRequest {
  readonly command: string
  /** Absolute workspace folder; the command runs with it as cwd. */
  readonly cwd: string
  readonly timeoutSec: number
  readonly keyField: string
  /** Abort an in-flight poll (owner shutdown); the whole process tree is killed. */
  readonly signal?: AbortSignal
}

/**
 * Main-side lifecycle binding. The remote server has no registry (its trigger
 * service owns the running set), so this stays optional; callers that have one
 * must pass it.
 */
export interface PollFetcherLifecycle {
  readonly registry: ProcessLifecycleRegistry
  /** Defaults to the app owner: trigger scheduling outlives individual windows. */
  readonly owner?: ProcessOwner
}

export interface PollFetcherOptions {
  readonly lifecycle?: PollFetcherLifecycle
}

export type PollItem = TriggerPollItem

export type PollFetchResult = TriggerPollResult

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

/** Synchronous tree kill so a fail path settles before the caller cleans up. */
const syncTreeKiller: TreeKiller = (pid) => {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch {
    // The child may already be gone.
  }
}

function pollCancelledError(): string {
  return localize('triggers.error.pollCancelled', 'The poll command was cancelled')
}

/**
 * Default fetcher: shell command, workspace cwd, hard timeout, 1 MB stdout cap.
 *
 * The child is wrapped in {@link ManagedChildProcess}: timeout / abort / the
 * stdout cap force-kill the whole tree (`taskkill /T` on Windows, the POSIX
 * process group). Main-side callers also bind it to the app owner in the process
 * lifecycle registry; the remote server has none, so its trigger service tracks
 * in-flight polls and aborts them on dispose (daemon shutdown / detach).
 */
export function createPollCommandFetcher(
  logger?: ILogger,
  options: PollFetcherOptions = {},
): PollCommandFetcher {
  return (request) =>
    new Promise<PollFetchResult>((resolve) => {
      if (request.signal?.aborted === true) {
        resolve({ ok: false, error: pollCancelledError() })
        return
      }
      const decoder = new StringDecoder('utf8')
      let output = ''
      let outputBytes = 0
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let detachAbort: (() => void) | undefined
      const rawListeners: (() => void)[] = []

      const raw = spawn(request.command, {
        cwd: request.cwd,
        shell: true,
        windowsHide: true,
        // A POSIX process group lets us kill the shell *and* its descendants.
        ...processGroupSpawnOptions(),
      })
      const child = new ManagedChildProcess(raw, {
        ...(logger === undefined ? {} : { logger }),
        label: 'trigger-poll',
        // shell: true wraps the command in cmd.exe on Windows; a plain kill would
        // orphan the real command, so recurse the PID tree there.
        treeKill: true,
        processGroup: process.platform !== 'win32',
        killTree: syncTreeKiller,
        ...(options.lifecycle === undefined
          ? {}
          : {
              lifecycle: {
                registry: options.lifecycle.registry,
                owner: options.lifecycle.owner ?? APP_OWNER,
                role: 'trigger-poll',
              },
            }),
      })
      const detach = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        detachAbort?.()
        detachAbort = undefined
        for (const off of rawListeners.splice(0)) off()
      }
      const finish = (result: PollFetchResult): void => {
        if (settled) return
        settled = true
        detach()
        child.dispose()
        resolve(result)
      }
      const fail = (error: string): void => {
        if (settled) return
        child.hardKill()
        finish({ ok: false, error })
      }

      timer = setTimeout(
        () =>
          fail(
            localize('triggers.error.pollTimeout', 'The poll command timed out after {seconds}s', {
              seconds: request.timeoutSec,
            }),
          ),
        request.timeoutSec * 1000,
      )
      timer.unref?.()

      const signal = request.signal
      if (signal !== undefined) {
        const onAbort = (): void => fail(pollCancelledError())
        signal.addEventListener('abort', onAbort, { once: true })
        detachAbort = () => signal.removeEventListener('abort', onAbort)
      }

      // The old `stdio: ['ignore', …]` handed the command EOF on stdin; a default
      // pipe would leave a command that reads stdin waiting for the timeout.
      child.endStdin()

      child.onStdout((chunk: Buffer) => {
        if (settled) return
        outputBytes += chunk.byteLength
        if (outputBytes > POLL_MAX_STDOUT_BYTES) {
          fail(
            localize(
              'triggers.error.pollTooLarge',
              'The poll command printed more than 1 MB and was stopped',
            ),
          )
          return
        }
        output += decoder.write(chunk)
      })
      // ManagedChildProcess drains stderr unconditionally, so a chatty command
      // cannot block on a full pipe; content is deliberately never logged.

      // Parse on `close` (not `exit`): Node may still deliver buffered stdout
      // after `exit`, which would truncate the JSON payload.
      const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
        if (settled) return
        output += decoder.end()
        if (code === 0) {
          finish(parsePollStdout(output, request.keyField, logger))
          return
        }
        finish({
          ok: false,
          error: describePollExecError(
            {
              ...(code === null ? {} : { code }),
              ...(closeSignal === null ? {} : { signal: closeSignal }),
            },
            request.timeoutSec,
          ),
        })
      }
      const onError = (): void =>
        finish({
          ok: false,
          error: localize(
            'triggers.error.pollCommandStart',
            'The poll command could not be started',
          ),
        })
      raw.on('close', onClose)
      raw.on('error', onError)
      rawListeners.push(
        () => raw.off('close', onClose),
        () => raw.off('error', onError),
      )
    })
}
