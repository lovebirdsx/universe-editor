import { describe, expect, it } from 'vitest'
import { PerforceGraphEditorInput } from '../PerforceGraphEditorInput.js'
import { normalizeGraphScopeSelection } from '../../perforceGraph/graphScopeSelection.js'

const SCOPE = normalizeGraphScopeSelection([{ path: 'X:/p4ws/main/src', isDirectory: true }])
const MERGED = normalizeGraphScopeSelection([
  { path: 'X:/p4ws/main/a.txt', isDirectory: false },
  { path: 'X:/p4ws/main/lib', isDirectory: true },
])

describe('PerforceGraphEditorInput', () => {
  it('unscoped input keeps the classic resource / id / name', () => {
    const input = new PerforceGraphEditorInput()
    expect(input.typeId).toBe('perforceGraph')
    expect(input.resource.toString()).toBe('universe:/perforceGraph')
    expect(input.id).toBe('universe:/perforceGraph')
    expect(input.getName()).toBe('Perforce Graph')
    expect(input.scope).toBeUndefined()
  })

  it('scoped input encodes the scope into resource and derives id from it', () => {
    const input = new PerforceGraphEditorInput(SCOPE)
    expect(input.typeId).toBe('perforceGraph')
    expect(input.resource.scheme).toBe('universe')
    expect(input.resource.path).toBe('/perforceGraph')
    expect(input.resource.query).toBeTruthy()
    expect(input.id).toBe(input.resource.toString())
    expect(input.scope).toEqual(SCOPE)
    expect(input.getName()).toBe('History: src')
  })

  it('a multi-path scope names the tab after the first path plus a count', () => {
    const input = new PerforceGraphEditorInput(MERGED)
    expect(input.getName()).toBe('History: a.txt +1')
  })

  it('the same selection shares an id regardless of click order (tab dedupe)', () => {
    const a = new PerforceGraphEditorInput(MERGED)
    const b = new PerforceGraphEditorInput(
      normalizeGraphScopeSelection([
        { path: 'X:/p4ws/main/lib', isDirectory: true },
        { path: 'X:/p4ws/main/a.txt', isDirectory: false },
      ]),
    )
    expect(a.id).toBe(b.id)
    expect(a.resource.toString()).toBe(b.resource.toString())
  })

  it('different scopes yield different ids', () => {
    const a = new PerforceGraphEditorInput(SCOPE)
    const b = new PerforceGraphEditorInput(
      normalizeGraphScopeSelection([{ path: 'X:/p4ws/main/lib', isDirectory: true }]),
    )
    expect(a.id).not.toBe(b.id)
    // A superset selection is its own tab, not the single-path one.
    expect(new PerforceGraphEditorInput(MERGED).id).not.toBe(b.id)
  })

  it('folds a differently-cased drive letter into the same tab id', () => {
    // Windows reaches the same file through either casing, so the tab identity has
    // to fold it — but ONLY the drive letter (scopePathKey, not a full toLowerCase
    // that would merge genuinely different files on a case-sensitive host).
    const upper = new PerforceGraphEditorInput(
      normalizeGraphScopeSelection([{ path: 'X:/p4ws/main/a.txt', isDirectory: false }]),
    )
    const lower = new PerforceGraphEditorInput(
      normalizeGraphScopeSelection([{ path: 'x:/p4ws/main/a.txt', isDirectory: false }]),
    )
    expect(upper.id).toBe(lower.id)
    // The rest of the path stays case-sensitive.
    expect(
      new PerforceGraphEditorInput(
        normalizeGraphScopeSelection([{ path: 'X:/p4ws/main/A.txt', isDirectory: false }]),
      ).id,
    ).not.toBe(upper.id)
  })

  it('serialize → deserialize round-trips a scoped input', () => {
    for (const scope of [SCOPE, MERGED]) {
      const input = new PerforceGraphEditorInput(scope)
      const restored = PerforceGraphEditorInput.deserialize(input.serialize())
      expect(restored).toBeInstanceOf(PerforceGraphEditorInput)
      expect(restored?.scope).toEqual(scope)
      expect(restored?.id).toBe(input.id)
      expect(restored?.getName()).toBe(input.getName())
    }
  })

  it('deserializes old unscoped data (undefined / null / empty object) to an unscoped input', () => {
    for (const legacy of [undefined, null, {}, { paths: [] }]) {
      const restored = PerforceGraphEditorInput.deserialize(legacy)
      expect(restored?.scope).toBeUndefined()
      expect(restored?.id).toBe('universe:/perforceGraph')
    }
  })

  it('returns null for malformed data', () => {
    expect(PerforceGraphEditorInput.deserialize('nope')).toBeNull()
    expect(PerforceGraphEditorInput.deserialize(42)).toBeNull()
    expect(PerforceGraphEditorInput.deserialize([])).toBeNull()
    expect(PerforceGraphEditorInput.deserialize({ paths: 'x' })).toBeNull()
    // Missing / wrong-typed entry fields.
    expect(PerforceGraphEditorInput.deserialize({ paths: [{ path: 'x' }] })).toBeNull()
    expect(PerforceGraphEditorInput.deserialize({ paths: [{ isDirectory: true }] })).toBeNull()
    expect(
      PerforceGraphEditorInput.deserialize({ paths: [{ path: 1, isDirectory: true }] }),
    ).toBeNull()
    expect(
      PerforceGraphEditorInput.deserialize({ paths: [{ path: 'x', isDirectory: 'yes' }] }),
    ).toBeNull()
    // An empty path would normalize away, leaving a scoped input with no paths —
    // which reads as "whole repo" on the extension side while the UI hides the
    // globe toggle. Reject it instead.
    expect(
      PerforceGraphEditorInput.deserialize({ paths: [{ path: '', isDirectory: false }] }),
    ).toBeNull()
    // One bad entry invalidates the whole scope (a partial tab would be a lie).
    expect(
      PerforceGraphEditorInput.deserialize({
        paths: [{ path: 'x', isDirectory: false }, { path: 'y' }],
      }),
    ).toBeNull()
  })
})
