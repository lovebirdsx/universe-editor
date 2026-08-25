/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single-writer funnel for aiSettings.json. The only writer is AiModelMainService
 *  (readers like aiSettingsProviders read through readAiSettingsRoot), so every
 *  read-modify-write and whole-file write goes through one per-path serial queue.
 *  The atomic write uses a unique tmp name (pid alone is not enough — two writers
 *  in one process collide), renames into place, and chmods 0600 on POSIX so
 *  provider apiKeys and agent credential keys never linger at 0644.
 *  The rename retries on Windows transient locks (an indexer or AV holding the
 *  target for a few ms surfaces as EPERM), matching the other atomic writers in
 *  the repo — see node-services `installedExtensionsManifest.renameWithRetries`.
 *--------------------------------------------------------------------------------------------*/

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse } from 'jsonc-parser'

const queues = new Map<string, Promise<void>>()
let tmpSeq = 0

const RENAME_ATTEMPTS = 10
const RENAME_RETRY_DELAY_MS = 100
const RENAME_RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

export async function readAiSettingsRoot(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = parse(raw, [], { allowTrailingComma: true })
    return asRecord(parsed) ?? {}
  } catch {
    return {}
  }
}

/**
 * Serialized read-modify-write: reads the current root, applies `mutate`, and
 * atomically writes the result. Concurrent callers for the same path are queued
 * so neither can clobber the other's update.
 */
export async function mutateAiSettingsFile(
  path: string,
  mutate: (root: Record<string, unknown>) => void,
  onChmodError?: (error: Error) => void,
): Promise<void> {
  await enqueue(path, async () => {
    const root = await readAiSettingsRoot(path)
    mutate(root)
    await atomicWrite(path, root, onChmodError)
  })
}

/** Serialized whole-file write (the one-time migration path). */
export async function writeAiSettingsFile(
  path: string,
  root: Record<string, unknown>,
  onChmodError?: (error: Error) => void,
): Promise<void> {
  await enqueue(path, () => atomicWrite(path, root, onChmodError))
}

function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(task)
  queues.set(
    path,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  )
  return operation
}

async function atomicWrite(
  path: string,
  root: Record<string, unknown>,
  onChmodError?: (error: Error) => void,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
  await writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  await renameWithRetries(tmp, path)
  if (process.platform !== 'win32') {
    try {
      await chmod(path, 0o600)
    } catch (err) {
      // Some mounts don't support permission bits; never fail the write over it.
      onChmodError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

async function renameWithRetries(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRYABLE.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS))
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
