/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  RELOAD_ARM_INTENT_TTL_MS,
  clearReloadArmIntent,
  consumeReloadArmIntent,
  readReminderCooldownAt,
  writeReloadArmIntent,
  writeReminderCooldownAt,
  type SessionStorageLike,
} from '../diagnosisReloadSession.js'

/** In-memory stand-in for sessionStorage; `undefined` stands for "no DOM at all". */
function storage(initial: Record<string, string> = {}): SessionStorageLike & {
  readonly entries: Map<string, string>
} {
  const entries = new Map<string, string>(Object.entries(initial))
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  }
}

const NOW = 1_000_000

describe('reload arm intent', () => {
  /** The two refusals are different facts, so the tests name them rather than a boolean. */
  const armed = { armed: true } as const
  const none = { armed: false, reason: 'none' } as const
  const expired = { armed: false, reason: 'expired' } as const

  it('survives exactly one read, then clears itself', () => {
    const store = storage()
    writeReloadArmIntent(store, NOW)
    expect(consumeReloadArmIntent(store, NOW + 1)).toEqual(armed)
    // A reload that never happened must not arm the next one an hour later.
    expect(consumeReloadArmIntent(store, NOW + 2)).toEqual(none)
    expect(store.entries.size).toBe(0)
  })

  it('drops an intent that is older than the window a reload takes', () => {
    const store = storage()
    writeReloadArmIntent(store, NOW)
    // Reported as `expired`, not as `none`: the user did ask for this round, so the round
    // silently not starting is a fact worth being able to log.
    expect(consumeReloadArmIntent(store, NOW + RELOAD_ARM_INTENT_TTL_MS + 1)).toEqual(expired)
    expect(store.entries.size).toBe(0)
  })

  it('accepts an intent right at the edge of its lifetime', () => {
    const store = storage()
    writeReloadArmIntent(store, NOW)
    expect(consumeReloadArmIntent(store, NOW + RELOAD_ARM_INTENT_TTL_MS)).toEqual(armed)
  })

  it('treats a malformed or future-dated intent as absent instead of throwing', () => {
    for (const raw of ['', 'not json', '{}', '{"at":"soon"}', '{"at":null}', '{"at":-1}']) {
      const store = storage({ 'universe.memory.reloadArmIntent': raw })
      expect(consumeReloadArmIntent(store, NOW), raw).toEqual(none)
      expect(store.entries.size, raw).toBe(0)
    }
    const future = storage()
    writeReloadArmIntent(future, NOW + 60_000)
    expect(consumeReloadArmIntent(future, NOW)).toEqual(none)
  })

  it('can be cleared by a caller that decided not to reload after all', () => {
    const store = storage()
    writeReloadArmIntent(store, NOW)
    clearReloadArmIntent(store)
    // The reload was refused, so there is nothing left to expire — it reads as never written.
    expect(consumeReloadArmIntent(store, NOW)).toEqual(none)
  })

  it('is a no-op without a storage at all', () => {
    expect(() => writeReloadArmIntent(undefined, NOW)).not.toThrow()
    expect(() => clearReloadArmIntent(undefined)).not.toThrow()
    expect(consumeReloadArmIntent(undefined, NOW)).toEqual(none)
  })
})

describe('reminder cooldown', () => {
  it('round-trips the last reminder so a reload cannot re-arm the prompt', () => {
    const store = storage()
    writeReminderCooldownAt(store, NOW)
    expect(readReminderCooldownAt(store, NOW + 60_000)).toBe(NOW)
  })

  it('ignores a cooldown that is malformed or dated in the future', () => {
    // A future timestamp would make every later reading look like it is inside the
    // cooldown, silencing the reminder for as long as the skew lasts.
    for (const raw of ['', 'nope', '{"at":"x"}', '[]', '{"at":null}']) {
      const store = storage({ 'universe.memory.reminderCooldownAt': raw })
      expect(readReminderCooldownAt(store, NOW), raw).toBeUndefined()
    }
    const future = storage()
    writeReminderCooldownAt(future, NOW + 1)
    expect(readReminderCooldownAt(future, NOW)).toBeUndefined()
  })

  it('is a no-op without a storage at all', () => {
    expect(() => writeReminderCooldownAt(undefined, NOW)).not.toThrow()
    expect(readReminderCooldownAt(undefined, NOW)).toBeUndefined()
  })
})
