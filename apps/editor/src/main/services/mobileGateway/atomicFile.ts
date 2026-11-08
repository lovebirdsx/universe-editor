/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Atomic, permission-restricted JSON writes for the mobile gateway's user data.
 *  Mirrors aiSettingsFile.ts: write a unique tmp file next to the target, rename
 *  into place (retrying transient Windows locks), then chmod 0600 on POSIX so
 *  device hashes never linger at 0644.
 *--------------------------------------------------------------------------------------------*/

import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const RENAME_ATTEMPTS = 10
const RENAME_RETRY_DELAY_MS = 100
const RENAME_RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

let tmpSeq = 0

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  onChmodError?: (error: Error) => void,
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, onChmodError)
}

export async function writeFileAtomic(
  path: string,
  content: string,
  onChmodError?: (error: Error) => void,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
  await renameWithRetries(tmp, path)
  await chmodPrivate(path, onChmodError)
}

export async function chmodPrivate(
  path: string,
  onChmodError?: (error: Error) => void,
): Promise<void> {
  if (process.platform === 'win32') return
  try {
    await chmod(path, 0o600)
  } catch (err) {
    // Some mounts don't support permission bits; never fail the write over it.
    onChmodError?.(err instanceof Error ? err : new Error(String(err)))
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
