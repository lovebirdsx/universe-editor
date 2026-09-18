/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The two facts that have to outlive a renderer: the one-shot intent left behind by
 *  "reload and start the memory diagnosis", and when the user was last reminded.
 *
 *  sessionStorage rather than IStorageService on purpose. The intent is a flag for the
 *  *next renderer of this window* and nobody else: a persistent store would be read back
 *  on a cold start days later and arm a round nobody asked for. Same reasoning as the
 *  disposable-leak report already carried across reloads this way.
 *
 *  Storage is a parameter, never a global: the renderer-node test project has no
 *  sessionStorage, and the whole file has to stay testable there.
 *--------------------------------------------------------------------------------------------*/

/** The slice of `Storage` this module needs — `Storage` itself drags DOM types in. */
export interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const RELOAD_ARM_INTENT_KEY = 'universe.memory.reloadArmIntent'
export const REMINDER_COOLDOWN_KEY = 'universe.memory.reminderCooldownAt'

/**
 * How long the arm intent stays valid. It only has to survive the reload it was written
 * for — seconds — so a window this short is safe: an intent that outlived its reload is
 * exactly the "reload later and a diagnosis starts by itself" case that must not happen.
 */
export const RELOAD_ARM_INTENT_TTL_MS = 90_000

/**
 * The renderer's sessionStorage, or undefined where there is none (node tests, a sandbox
 * that denies access). Resolved lazily rather than captured at module load: an import
 * that runs before the DOM exists must not decide this for the whole process.
 */
export function rendererSessionStorage(): SessionStorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

export function writeReloadArmIntent(storage: SessionStorageLike | undefined, at: number): void {
  write(storage, RELOAD_ARM_INTENT_KEY, at)
}

export function clearReloadArmIntent(storage: SessionStorageLike | undefined): void {
  remove(storage, RELOAD_ARM_INTENT_KEY)
}

/**
 * What a renderer that just came back found in storage.
 *
 * `expired` is called out rather than folded into `none` because the two are opposite
 * conclusions about the same silence: nobody asked for a round, versus the user asked, the
 * reload happened, and the diagnosis quietly did not start. Only one of those is a bug.
 */
export type ReloadArmOutcome =
  | { readonly armed: true }
  | { readonly armed: false; readonly reason: 'none' | 'expired' }

/**
 * Consume the intent, if there is a live one. Read-and-clear in one step: it belongs to
 * the renderer that comes back from that reload and to no other, so a second call — and
 * every later reload — must see nothing.
 */
export function consumeReloadArmIntent(
  storage: SessionStorageLike | undefined,
  now: number,
): ReloadArmOutcome {
  if (!storage) return { armed: false, reason: 'none' }
  const at = read(storage, RELOAD_ARM_INTENT_KEY, now)
  remove(storage, RELOAD_ARM_INTENT_KEY)
  if (at === undefined) return { armed: false, reason: 'none' }
  return now - at <= RELOAD_ARM_INTENT_TTL_MS
    ? { armed: true }
    : { armed: false, reason: 'expired' }
}

export function writeReminderCooldownAt(storage: SessionStorageLike | undefined, at: number): void {
  write(storage, REMINDER_COOLDOWN_KEY, at)
}

/**
 * When the user was last reminded, if that reading is still usable. Kept separate from the
 * in-memory "already reminded this renderer" flag: that one dies with the renderer, this
 * one is what stops a reload from being a way to be asked again.
 */
export function readReminderCooldownAt(
  storage: SessionStorageLike | undefined,
  now: number,
): number | undefined {
  if (!storage) return undefined
  return read(storage, REMINDER_COOLDOWN_KEY, now)
}

/** Epoch ms payload. An object rather than a bare number so the shape can grow. */
function write(storage: SessionStorageLike | undefined, key: string, at: number): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify({ at }))
  } catch {
    // Quota, or a storage that refuses writes at all. Both mean "no intent", which the
    // caller already treats as a valid outcome.
  }
}

function remove(storage: SessionStorageLike | undefined, key: string): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Same as above: nothing to recover, and throwing here would take down a reload.
  }
}

/**
 * A timestamp, or undefined. Anything unusable is removed on the way out rather than left
 * to be re-parsed forever — and a timestamp in the future is unusable, not merely odd: it
 * would make every later reading look like it falls inside the cooldown.
 */
function read(storage: SessionStorageLike, key: string, now: number): number | undefined {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return undefined
  }
  if (raw === null) return undefined

  let at: unknown
  try {
    at = (JSON.parse(raw) as { at?: unknown }).at
  } catch {
    at = undefined
  }
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now) {
    remove(storage, key)
    return undefined
  }
  return at
}
