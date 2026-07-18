import { describe, it, expect } from 'vitest'
import {
  computeActiveExtensions,
  parseIdSet,
  type ActivationFilter,
} from '../extensionActivationFilter.js'
import type { IScannedExtension } from '../extensionScanner.js'

function ext(id: string, builtin = true): IScannedExtension {
  return {
    id,
    builtin,
    manifest: { name: id } as IScannedExtension['manifest'],
    extensionPath: `/ext/${id}`,
  }
}

describe('computeActiveExtensions', () => {
  it('de-dupes by id, keeping the first occurrence (built-in wins over user)', () => {
    const scanned = [ext('a', true), ext('b', true), ext('a', false)]
    const { deduped, active } = computeActiveExtensions(scanned)
    expect(deduped.map((e) => e.id)).toEqual(['a', 'b'])
    // First 'a' is the built-in one.
    expect(deduped[0]?.builtin).toBe(true)
    expect(active.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('with no filter, activates every de-duped extension', () => {
    const { active } = computeActiveExtensions([ext('a'), ext('b')])
    expect(active.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('drops disabled ids', () => {
    const filter: ActivationFilter = { disabled: new Set(['b']) }
    const { active } = computeActiveExtensions([ext('a'), ext('b'), ext('c')], filter)
    expect(active.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('with an allowlist, activates ONLY listed built-in ids', () => {
    const filter: ActivationFilter = { allowlist: new Set(['b']) }
    const { active } = computeActiveExtensions([ext('a'), ext('b'), ext('c')], filter)
    expect(active.map((e) => e.id)).toEqual(['b'])
  })

  it('an empty allowlist activates no built-ins (core-only e2e)', () => {
    const filter: ActivationFilter = { allowlist: new Set() }
    const { active } = computeActiveExtensions([ext('a'), ext('b')], filter)
    expect(active).toEqual([])
  })

  it('the allowlist gates built-ins only — user-installed extensions always activate', () => {
    // e2e installs a vsix at runtime (builtin: false) under an empty/partial
    // allowlist; it must still activate (the seam blocks bundled hosts, not installs).
    const filter: ActivationFilter = { allowlist: new Set(['a']) }
    const scanned = [ext('a', true), ext('b', true), ext('user.vsix', false)]
    const { active } = computeActiveExtensions(scanned, filter)
    expect(active.map((e) => e.id)).toEqual(['a', 'user.vsix'])
  })

  it('an empty allowlist still activates user-installed extensions', () => {
    const filter: ActivationFilter = { allowlist: new Set() }
    const scanned = [ext('builtin.x', true), ext('user.vsix', false)]
    const { active } = computeActiveExtensions(scanned, filter)
    expect(active.map((e) => e.id)).toEqual(['user.vsix'])
  })

  it('disabled still drops a user-installed extension even without an allowlist', () => {
    const filter: ActivationFilter = { disabled: new Set(['user.vsix']) }
    const scanned = [ext('a', true), ext('user.vsix', false)]
    const { active } = computeActiveExtensions(scanned, filter)
    expect(active.map((e) => e.id)).toEqual(['a'])
  })

  it('allowlist composes with disabled: a listed-but-disabled id stays off', () => {
    const filter: ActivationFilter = {
      allowlist: new Set(['a', 'b']),
      disabled: new Set(['b']),
    }
    const { active } = computeActiveExtensions([ext('a'), ext('b')], filter)
    expect(active.map((e) => e.id)).toEqual(['a'])
  })
})

describe('parseIdSet', () => {
  it('returns undefined when unset (activate all)', () => {
    expect(parseIdSet(undefined)).toBeUndefined()
  })

  it('returns an empty set for an empty string (activate none)', () => {
    const set = parseIdSet('')
    expect(set).toBeInstanceOf(Set)
    expect(set?.size).toBe(0)
  })

  it('splits and trims empty entries', () => {
    expect([...(parseIdSet('a,b,,c') ?? [])]).toEqual(['a', 'b', 'c'])
  })
})
