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
})
