/**
 * Cross-window delivery lock. Lives in the repository's shared git common dir so
 * every worktree and every editor window sees the same lock. `mkdir` is the
 * atomic step; the owner record is written right after. A lock left behind by a
 * crashed process is reclaimed by TTL, or immediately when it belongs to a dead
 * PID on this host.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type {
  DeliveryAcquireLockData,
  DeliveryAcquireLockInput,
  DeliveryAcquireLockResult,
  DeliveryLockOwner,
  DeliveryLockResult,
  DeliveryLockTokenInput,
} from './deliveryTypes.js'

type Log = ((msg: string) => void) | undefined

const LOCK_DIR_NAME = 'delivery.lock'
const OWNER_FILE = 'owner.json'
const LOCK_TTL_MS = 10 * 60_000
const ACQUIRE_ATTEMPTS = 3
/** A fresh lock directory without an owner is still being initialized. */
const LOCK_INITIALIZING_MS = 5_000

const lockRoot = (commonDir: string): string => join(commonDir, 'universe-editor')
export const deliveryLockDir = (commonDir: string): string =>
  join(lockRoot(commonDir), LOCK_DIR_NAME)
const ownerPath = (commonDir: string): string => join(deliveryLockDir(commonDir), OWNER_FILE)

const parseOwner = (raw: string): DeliveryLockOwner | undefined => {
  try {
    const value = JSON.parse(raw) as Partial<DeliveryLockOwner>
    if (typeof value.token !== 'string' || value.token.length === 0) return undefined
    if (typeof value.pid !== 'number' || !Number.isFinite(value.pid)) return undefined
    if (typeof value.hostname !== 'string') return undefined
    if (typeof value.heartbeatAt !== 'string') return undefined
    if (typeof value.startedAt !== 'string') return undefined
    return {
      token: value.token,
      pid: value.pid,
      hostname: value.hostname,
      startedAt: value.startedAt,
      heartbeatAt: value.heartbeatAt,
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
    }
  } catch {
    return undefined
  }
}

const readOwner = async (commonDir: string): Promise<DeliveryLockOwner | undefined> => {
  try {
    return parseOwner(await readFile(ownerPath(commonDir), 'utf8'))
  } catch {
    return undefined
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const isStale = (owner: DeliveryLockOwner, now: number): boolean => {
  if (owner.hostname === hostname() && !pidAlive(owner.pid)) return true
  const heartbeat = Date.parse(owner.heartbeatAt)
  if (!Number.isFinite(heartbeat)) return true
  return now - heartbeat > LOCK_TTL_MS
}

const isFreshLockDir = async (commonDir: string): Promise<boolean> => {
  try {
    const info = await stat(deliveryLockDir(commonDir))
    return Date.now() - info.mtimeMs < LOCK_INITIALIZING_MS
  } catch {
    return false
  }
}

const writeOwner = async (commonDir: string, owner: DeliveryLockOwner): Promise<void> => {
  const target = ownerPath(commonDir)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(owner), 'utf8')
  await rename(tmp, target)
}

export async function acquireDeliveryLock(
  input: DeliveryAcquireLockInput,
  log?: Log,
): Promise<DeliveryAcquireLockResult> {
  const dir = deliveryLockDir(input.commonDir)
  await mkdir(lockRoot(input.commonDir), { recursive: true })
  const now = Date.now()
  const owner: DeliveryLockOwner = {
    token: input.token,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    ...(input.label !== undefined ? { label: input.label } : {}),
  }

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    let created = false
    try {
      await mkdir(dir)
      created = true
      await writeOwner(input.commonDir, owner)
      log?.(`[git] delivery lock acquired at ${dir}`)
      const data: DeliveryAcquireLockData = { acquired: true, owner }
      return { ok: true, ...data }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (created) await rm(dir, { recursive: true, force: true })
        return {
          ok: false,
          error: {
            code: 'git_failed',
            message: 'Could not create the delivery lock.',
            detail: String(err),
          },
        }
      }
      const existing = await readOwner(input.commonDir)
      if (existing !== undefined && !isStale(existing, Date.now())) {
        log?.(`[git] delivery lock held by pid ${existing.pid}`)
        const data: DeliveryAcquireLockData = { acquired: false, owner: existing }
        return { ok: true, ...data }
      }
      if (existing === undefined && (await isFreshLockDir(input.commonDir))) {
        // Another window created the directory but has not written owner.json yet.
        // Deleting it here would hand the same lock to two windows.
        log?.('[git] delivery lock is being initialized by another window')
        const data: DeliveryAcquireLockData = { acquired: false }
        return { ok: true, ...data }
      }
      log?.(`[git] removing stale delivery lock at ${dir}`)
      await rm(dir, { recursive: true, force: true })
    }
  }

  const data: DeliveryAcquireLockData = { acquired: false }
  return { ok: true, ...data }
}

export async function heartbeatDeliveryLock(
  input: DeliveryLockTokenInput,
  log?: Log,
): Promise<DeliveryLockResult> {
  const owner = await readOwner(input.commonDir)
  if (owner === undefined || owner.token !== input.token) {
    return {
      ok: false,
      error: { code: 'lock_lost', message: 'The delivery lock is no longer held by this session.' },
    }
  }
  await writeOwner(input.commonDir, { ...owner, heartbeatAt: new Date().toISOString() })
  log?.('[git] delivery lock heartbeat')
  return { ok: true, released: false }
}

export async function releaseDeliveryLock(
  input: DeliveryLockTokenInput,
  log?: Log,
): Promise<DeliveryLockResult> {
  const owner = await readOwner(input.commonDir)
  if (owner === undefined) {
    // Never delete a directory whose owner has not been written yet: it may be
    // another window in the middle of acquiring the lock.
    return { ok: true, released: false }
  }
  if (owner.token !== input.token) {
    return {
      ok: false,
      error: { code: 'lock_lost', message: 'The delivery lock belongs to another session.' },
    }
  }
  await rm(deliveryLockDir(input.commonDir), { recursive: true, force: true })
  log?.('[git] delivery lock released')
  return { ok: true, released: true }
}

/** Whether `token` still owns the lock. Mutating delivery commands call this. */
export async function isDeliveryLockHeld(commonDir: string, token: string): Promise<boolean> {
  const owner = await readOwner(commonDir)
  return owner !== undefined && owner.token === token
}

export async function isDeliveryLockActive(
  commonDir: string,
): Promise<DeliveryLockOwner | undefined> {
  const owner = await readOwner(commonDir)
  if (owner === undefined) return undefined
  return isStale(owner, Date.now()) ? undefined : owner
}
