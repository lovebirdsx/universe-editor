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

  it('shares one model across two inputs with the same untitled name', async () => {
    const source = new UntitledEditorInput()
    const sourceModel = await source.resolveModel()
    sourceModel.setValue('draft')

    const copy = new UntitledEditorInput(source.getName())
    expect(await copy.resolveModel()).toBe(sourceModel)

    copy.dispose()
    expect(MonacoModelRegistry.peek(source.resource)).toBe(sourceModel)
    source.dispose()
    expect(MonacoModelRegistry.peek(source.resource)).toBeUndefined()
  })

  it('starts dirty when restored with text, matching updateDirtyFromModel', () => {
    const input = new UntitledEditorInput('Untitled-900', 'draft')
    expect(input.isDirty).toBe(true)
  })

  it('stays clean when constructed/restored empty', () => {
    expect(new UntitledEditorInput('Untitled-901').isDirty).toBe(false)
    expect(new UntitledEditorInput('Untitled-902', '').isDirty).toBe(false)
  })

  it('deserialize marks a non-empty buffer dirty before its tab can mount', () => {
    const input = UntitledEditorInput.deserialize({ name: 'Untitled-903', content: 'unsaved' })
    expect(input?.isDirty).toBe(true)
    const empty = UntitledEditorInput.deserialize({ name: 'Untitled-904', content: '' })
    expect(empty?.isDirty).toBe(false)
  })

  it('migrateFrom retains the shared buffer before the source is disposed', async () => {
    const source = new UntitledEditorInput()
    const sourceModel = await source.resolveModel()
    sourceModel.setValue('draft')
    source.setDirty(true)

    const target = new UntitledEditorInput(source.getName())
    target.migrateFrom(source)
    source.dispose()

    expect(MonacoModelRegistry.peek(target.resource)).toBe(sourceModel)
    expect(target.isDirty).toBe(true)
    expect((await target.resolveModel()).getValue()).toBe('draft')

    target.dispose()
    expect(MonacoModelRegistry.peek(target.resource)).toBeUndefined()
  })
})
