import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { resolveOpenChangesTarget } from '../openChanges.js'

describe('resolveOpenChangesTarget', () => {
  it('returns undefined for undefined and non-object arguments', () => {
    expect(resolveOpenChangesTarget(undefined)).toBeUndefined()
    expect(resolveOpenChangesTarget(null)).toBeUndefined()
    expect(resolveOpenChangesTarget(42)).toBeUndefined()
    expect(resolveOpenChangesTarget('D:/repo/a.ts')).toBeUndefined()
  })

  it('returns a bare URI unchanged', () => {
    const uri = URI.file('D:/repo/a.ts')
    expect(resolveOpenChangesTarget(uri)).toBe(uri)
  })

  it('extracts the resource from the explorer shape', () => {
    const uri = URI.file('D:/repo/a.ts')
    expect(resolveOpenChangesTarget({ resource: uri })).toBe(uri)
  })

  it('revives a UriComponents resource that crossed a process boundary', () => {
    const target = resolveOpenChangesTarget({
      resource: { scheme: 'file', path: '/C:/repo/a.ts' },
    })
    expect(target).toBeInstanceOf(URI)
    expect(target?.scheme).toBe('file')
    expect(target?.toString()).toBe('file:///C:/repo/a.ts')
  })

  it('returns undefined for the editor-title shape (groupId only)', () => {
    expect(resolveOpenChangesTarget({ groupId: 0 })).toBeUndefined()
  })

  it('returns undefined for a resource object without a scheme', () => {
    expect(resolveOpenChangesTarget({ resource: {} })).toBeUndefined()
  })
})
