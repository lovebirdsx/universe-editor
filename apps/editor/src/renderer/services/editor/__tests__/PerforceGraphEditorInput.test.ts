import { describe, expect, it } from 'vitest'
import { PerforceGraphEditorInput } from '../PerforceGraphEditorInput.js'

const SCOPE = { path: 'X:/p4ws/main/src', isDirectory: true, label: 'src' }

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

  it('two inputs with the same scope share an id regardless of key order (tab dedupe)', () => {
    const a = new PerforceGraphEditorInput(SCOPE)
    const b = new PerforceGraphEditorInput({
      label: 'src',
      isDirectory: true,
      path: 'X:/p4ws/main/src',
    })
    expect(a.id).toBe(b.id)
    expect(a.resource.toString()).toBe(b.resource.toString())
  })

  it('different scopes yield different ids', () => {
    const a = new PerforceGraphEditorInput(SCOPE)
    const b = new PerforceGraphEditorInput({
      path: 'X:/p4ws/main/lib',
      isDirectory: true,
      label: 'lib',
    })
    expect(a.id).not.toBe(b.id)
  })

  it('serialize → deserialize round-trips a scoped input', () => {
    const input = new PerforceGraphEditorInput(SCOPE)
    const restored = PerforceGraphEditorInput.deserialize(input.serialize())
    expect(restored).toBeInstanceOf(PerforceGraphEditorInput)
    expect(restored?.scope).toEqual(SCOPE)
    expect(restored?.id).toBe(input.id)
    expect(restored?.getName()).toBe(input.getName())
  })

  it('deserializes old unscoped data (undefined / null / empty object) to an unscoped input', () => {
    for (const legacy of [undefined, null, {}]) {
      const restored = PerforceGraphEditorInput.deserialize(legacy)
      expect(restored?.scope).toBeUndefined()
      expect(restored?.id).toBe('universe:/perforceGraph')
    }
  })

  it('returns null for malformed data', () => {
    expect(PerforceGraphEditorInput.deserialize('nope')).toBeNull()
    expect(PerforceGraphEditorInput.deserialize(42)).toBeNull()
    expect(PerforceGraphEditorInput.deserialize([])).toBeNull()
    // Missing fields.
    expect(PerforceGraphEditorInput.deserialize({ path: 'x' })).toBeNull()
    expect(PerforceGraphEditorInput.deserialize({ path: 'x', isDirectory: true })).toBeNull()
    // Wrong field types.
    expect(
      PerforceGraphEditorInput.deserialize({ path: 1, isDirectory: true, label: 'l' }),
    ).toBeNull()
    expect(
      PerforceGraphEditorInput.deserialize({ path: 'x', isDirectory: 'yes', label: 'l' }),
    ).toBeNull()
    expect(
      PerforceGraphEditorInput.deserialize({ path: 'x', isDirectory: true, label: 3 }),
    ).toBeNull()
  })
})
