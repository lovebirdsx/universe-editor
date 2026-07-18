import { describe, it, expect } from 'vitest'
import { URI } from '@universe-editor/platform'
import { DiffEditorInput } from '../DiffEditorInput.js'

describe('DiffEditorInput', () => {
  it('same-file diff keeps the legacy id / name / modifiedUri', () => {
    const uri = URI.file('/ws/a.ts')
    const input = new DiffEditorInput(uri, 'base', 'current')
    expect(input.id).toBe(`diff:${uri.toString()}`)
    expect(input.getName()).toBe('a.ts (Diff)')
    expect(input.modifiedUri.toString()).toBe(uri.toString())
    expect(input.resource.scheme).toBe('diff')
    expect(input.isCrossFile).toBe(false)
  })

  it('cross-file diff exposes both URIs and a distinct id / name', () => {
    const left = URI.file('/ws/a.ts')
    const right = URI.file('/ws/b.ts')
    const input = new DiffEditorInput(left, 'A', 'B', right)
    expect(input.originalUri.toString()).toBe(left.toString())
    expect(input.modifiedUri.toString()).toBe(right.toString())
    expect(input.getName()).toBe('a.ts ↔ b.ts')
    expect(input.id).toBe(`diff:${left.toString()}↔${right.toString()}`)
    expect(input.isCrossFile).toBe(true)
    // Reverse comparison is a different tab.
    const reversed = new DiffEditorInput(right, 'B', 'A', left)
    expect(reversed.id).not.toBe(input.id)
  })

  it('passing the same URI for both sides falls back to same-file semantics', () => {
    const uri = URI.file('/ws/a.ts')
    const input = new DiffEditorInput(uri, 'base', 'current', uri)
    expect(input.id).toBe(`diff:${uri.toString()}`)
    expect(input.getName()).toBe('a.ts (Diff)')
    expect(input.isCrossFile).toBe(false)
  })

  it('exposes openableResource only when provided', () => {
    const uri = URI.file('/ws/a.ts')
    expect(new DiffEditorInput(uri, 'base', 'current').openableResource).toBeUndefined()
    const openable = URI.file('/ws/a.ts')
    const input = new DiffEditorInput(uri, 'base', 'current', undefined, openable)
    expect(input.openableResource?.toString()).toBe(openable.toString())
  })

  describe('serialize / deserialize (Ctrl+Shift+T, session restore)', () => {
    it('serializes the structural URIs AND both sides content', () => {
      const uri = URI.file('/ws/a.ts')
      const openable = URI.file('/ws/a.ts')
      const input = new DiffEditorInput(uri, 'base', 'current', undefined, openable)
      const data = input.serialize() as unknown as Record<string, unknown>
      expect(data['originalContent']).toBe('base')
      expect(data['modifiedContent']).toBe('current')
      expect(URI.revive(data['originalUri'] as never)?.toString()).toBe(uri.toString())
      expect(data['modifiedUri']).toBeUndefined() // same-file → omitted
      expect(URI.revive(data['openableResource'] as never)?.toString()).toBe(openable.toString())
    })

    it('serializes the modified URI for a cross-file compare', () => {
      const left = URI.file('/ws/a.ts')
      const right = URI.file('/ws/b.ts')
      const data = new DiffEditorInput(left, 'A', 'B', right).serialize() as unknown as Record<
        string,
        unknown
      >
      expect(URI.revive(data['modifiedUri'] as never)?.toString()).toBe(right.toString())
    })

    it('round-trips structure AND content through deserialize', () => {
      const uri = URI.file('/ws/a.ts')
      const openable = URI.file('/ws/a.ts')
      const original = new DiffEditorInput(uri, 'base', 'current', undefined, openable)
      const restored = DiffEditorInput.deserialize(original.serialize())
      expect(restored).not.toBeNull()
      expect(restored!.id).toBe(original.id)
      expect(restored!.isCrossFile).toBe(false)
      expect(restored!.openableResource?.toString()).toBe(openable.toString())
      // Content is preserved verbatim — the two sides must NOT collapse to empty
      // (that rendered as two identical panes / no diff on reopen).
      expect(restored!.originalContent).toBe('base')
      expect(restored!.modifiedContent).toBe('current')
      expect(restored!.originalContent).not.toBe(restored!.modifiedContent)
    })

    it('round-trips a cross-file compare identity + content', () => {
      const left = URI.file('/ws/a.ts')
      const right = URI.file('/ws/b.ts')
      const restored = DiffEditorInput.deserialize(
        new DiffEditorInput(left, 'A', 'B', right).serialize(),
      )
      expect(restored!.isCrossFile).toBe(true)
      expect(restored!.id).toBe(`diff:${left.toString()}↔${right.toString()}`)
      expect(restored!.originalContent).toBe('A')
      expect(restored!.modifiedContent).toBe('B')
    })

    it('rejects malformed payloads', () => {
      expect(DiffEditorInput.deserialize(null)).toBeNull()
      expect(DiffEditorInput.deserialize({})).toBeNull()
    })
  })
})
