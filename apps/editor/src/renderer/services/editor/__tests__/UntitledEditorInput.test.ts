/*---------------------------------------------------------------------------------------------
 *  Tests for UntitledEditorInput — basic identity + save/revert behavior (主题 11 WP3).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'
import { UntitledEditorInput } from '../UntitledEditorInput.js'

describe('UntitledEditorInput', () => {
  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('reports the untitled typeId', () => {
    const input = new UntitledEditorInput()
    expect(input.typeId).toBe('untitled')
  })

  it('uses the untitled URI scheme', () => {
    const input = new UntitledEditorInput()
    expect(input.resource.scheme).toBe('untitled')
  })

  it('resolves to an empty string', async () => {
    const input = new UntitledEditorInput()
    expect(await input.resolve()).toBe('')
  })

  it('save returns false so callers can fall back to Save-As', async () => {
    const input = new UntitledEditorInput()
    expect(await input.save()).toBe(false)
  })

  it('increments the counter across instances', () => {
    const a = new UntitledEditorInput()
    const b = new UntitledEditorInput()
    expect(a.getName()).not.toBe(b.getName())
  })

  it('keeps its model alive until the input is disposed', async () => {
    const input = new UntitledEditorInput()
    const model = await input.resolveModel()
    model.setValue('draft')
    expect(input.serialize().content).toBe('draft')

    input.dispose()
    expect(MonacoModelRegistry.peek(input.resource)).toBeUndefined()
  })
})
