/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single-writer funnel for aiSettings.json. Two writers — AiModelMainService and
 *  the module-level aiSettingsAgentState helpers — mutate this one file, so every
 *  read-modify-write and whole-file write goes through one per-path serial queue.
 *  The atomic write uses a unique tmp name (pid alone is not enough — two writers
 *  in one process collide), renames into place, and chmods 0600 on POSIX so
 *  provider apiKeys and agent credential keys never linger at 0644.
 *--------------------------------------------------------------------------------------------*/

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse } from 'jsonc-parser'

const queues = new Map<string, Promise<void>>()
let tmpSeq = 0

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
  await rename(tmp, path)
  if (process.platform !== 'win32') {
    try {
      await chmod(path, 0o600)
    } catch (err) {
      // Some mounts don't support permission bits; never fail the write over it.
      onChmodError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
