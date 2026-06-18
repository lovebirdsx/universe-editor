import { describe, expect, it } from 'vitest'
import { SchemaViewerInput } from '../SchemaViewerInput.js'

describe('SchemaViewerInput', () => {
  it('is a read-only json viewer named after the source file', () => {
    const input = new SchemaViewerInput('settings.json', '{}')
    expect(input.language).toBe('json')
    expect(input.isReadonly).toBe(true)
    expect(input.getName()).toContain('settings.json')
    expect(input.typeId).toBe(SchemaViewerInput.TYPE_ID)
  })

  it('derives a stable resource from the source name (same file → same tab)', () => {
    const a = new SchemaViewerInput('settings.json', '{"a":1}')
    const b = new SchemaViewerInput('settings.json', '{"b":2}')
    expect(a.resource.toString()).toBe(b.resource.toString())
    expect(a.matches(b)).toBe(true)
  })

  it('serves its content via resolve()', async () => {
    const input = new SchemaViewerInput('x.json', '{"type":"object"}')
    expect(await input.resolve()).toBe('{"type":"object"}')
  })

  it('never reports dirty', () => {
    const input = new SchemaViewerInput('x.json', '{}')
    input.updateDirtyFromModel()
    expect(input.isDirty).toBe(false)
  })
})
