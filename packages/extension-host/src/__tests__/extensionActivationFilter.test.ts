import { describe, it, expect } from 'vitest'
import {
  computeActiveExtensions,
  parseIdSet,
  type ActivationFilter,
} from '../extensionActivationFilter.js'
import type { IScannedExtension } from '../extensionScanner.js'

function ext(id: string, builtin = true, withMain = true): IScannedExtension {
  return {
    id,
    builtin,
    manifest: { name: id } as IScannedExtension['manifest'],
    extensionPath: `/ext/${id}`,
    ...(withMain ? { mainPath: `/ext/${id}/dist/index.js` } : {}),
  }
}

function devExt(id: string): IScannedExtension {
  return { ...ext(id, false), isUnderDevelopment: true }
}

function invalidExt(id: string): IScannedExtension {
  return {
    ...ext(id),
    isValid: false,
    validationMessage: 'requires universe >=99.0.0, host is 0.13.0',
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

  it('the allowlist never gates declaration-only built-ins (no host cost)', () => {
    // theme-defaults-style pure `contributes` extensions must stay active under
    // the minimal e2e set — the seam exists to skip bundled hosts, and a
    // declaration-only extension boots no host.
    const filter: ActivationFilter = { allowlist: new Set() }
    const scanned = [ext('host.lsp', true), ext('theme-defaults', true, false)]
    const { active } = computeActiveExtensions(scanned, filter)
    expect(active.map((e) => e.id)).toEqual(['theme-defaults'])
  })

  it('an empty allowlist activates no built-ins with a main module (core-only e2e)', () => {
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

  it('dev wins the id collision against built-in and user copies (scan order dev first)', () => {
    const scanned = [devExt('x'), ext('x', true), ext('x', false)]
    const { deduped } = computeActiveExtensions(scanned)
    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.isUnderDevelopment).toBe(true)
  })

  it('the disabled set never drops a dev extension (dev overrides everything)', () => {
    // The user disabled the SHIPPED build of the extension they are iterating
    // on; their dev copy must still activate (VSCode dev extensions don't
    // participate in enablement at all).
    const filter: ActivationFilter = { disabled: new Set(['x']) }
    const scanned = [devExt('x'), ext('x', true)]
    const { active } = computeActiveExtensions(scanned, filter)
    expect(active.map((e) => e.id)).toEqual(['x'])
    expect(active[0]?.isUnderDevelopment).toBe(true)
  })

  it('an empty allowlist still activates dev extensions (they are not built-ins)', () => {
    const filter: ActivationFilter = { allowlist: new Set() }
    const scanned = [devExt('dev.x'), ext('builtin.y', true)]
    const { active } = computeActiveExtensions(scanned, filter)
    expect(active.map((e) => e.id)).toEqual(['dev.x'])
  })

  it('drops version-incompatible extensions from active but keeps them deduped', () => {
    const { deduped, active } = computeActiveExtensions([ext('a'), invalidExt('b'), ext('c')])
    expect(deduped.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(active.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('a version-incompatible dev extension is also dropped (dev is not exempt)', () => {
    const scanned = [{ ...invalidExt('x'), isUnderDevelopment: true }, ext('y')]
    const { active } = computeActiveExtensions(scanned)
    expect(active.map((e) => e.id)).toEqual(['y'])
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
