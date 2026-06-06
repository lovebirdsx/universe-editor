import { describe, expect, it, beforeEach } from 'vitest'
import type { EditorInput } from '@universe-editor/platform'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { DiffEditorRegistry } from '../DiffEditorRegistry.js'

const input = (id: string) => ({ id }) as unknown as EditorInput
const diffEditor = () => ({}) as unknown as monaco.editor.IStandaloneDiffEditor

describe('DiffEditorRegistry', () => {
  beforeEach(() => DiffEditorRegistry._resetForTests())

  it('returns the registered editor for an input', () => {
    const a = input('a')
    const ed = diffEditor()
    DiffEditorRegistry.register(a, ed)
    expect(DiffEditorRegistry.get(a)).toBe(ed)
  })

  it('disambiguates split mounts by groupId', () => {
    const a = input('a')
    const ed1 = diffEditor()
    const ed2 = diffEditor()
    DiffEditorRegistry.register(a, ed1, 1)
    DiffEditorRegistry.register(a, ed2, 2)
    expect(DiffEditorRegistry.get(a, 1)).toBe(ed1)
    expect(DiffEditorRegistry.get(a, 2)).toBe(ed2)
    expect(DiffEditorRegistry.get(a, 3)).toBeUndefined()
  })

  it('falls back to the latest live instance when no groupId is given', () => {
    const a = input('a')
    const ed1 = diffEditor()
    const ed2 = diffEditor()
    DiffEditorRegistry.register(a, ed1, 1)
    DiffEditorRegistry.register(a, ed2, 2)
    expect(DiffEditorRegistry.get(a)).toBe(ed2)
  })

  it('drops the input entry once all instances unregister', () => {
    const a = input('a')
    const ed = diffEditor()
    DiffEditorRegistry.register(a, ed)
    DiffEditorRegistry.unregister(a, ed)
    expect(DiffEditorRegistry.get(a)).toBeUndefined()
  })
})
