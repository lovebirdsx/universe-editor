import { describe, expect, it } from 'vitest'
import { parseOpened, parseOpenedRecord, parsePending } from '../openedParser.js'

describe('parseOpenedRecord', () => {
  it('maps a default-changelist edit', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/a.txt',
      clientFile: 'D:/work/a.txt',
      change: 'default',
      action: 'edit',
      rev: '3',
    })
    expect(file).toEqual({
      depotFile: '//depot/a.txt',
      clientFile: 'D:/work/a.txt',
      changelist: 'default',
      action: 'edit',
      rev: '3',
      unresolved: false,
    })
  })

  it('maps a numbered changelist and preserves the id as a string', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/b.txt',
      clientFile: 'D:/work/b.txt',
      change: '12345',
      action: 'add',
    })
    expect(file?.changelist).toBe('12345')
    expect(file?.action).toBe('add')
    expect(file?.rev).toBeUndefined()
  })

  it('flags unresolved when the field is present', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/c.txt',
      clientFile: 'D:/work/c.txt',
      change: 'default',
      action: 'integrate',
      unresolved: '1',
    })
    expect(file?.unresolved).toBe(true)
  })

  it('normalizes an unknown action to edit and defaults missing change to default', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/d.txt',
      clientFile: 'D:/work/d.txt',
      action: 'weird',
    })
    expect(file?.action).toBe('edit')
    expect(file?.changelist).toBe('default')
  })

  it('returns undefined for a record without a depot path', () => {
    expect(parseOpenedRecord({ change: 'default' })).toBeUndefined()
  })

  it('preserves move actions verbatim', () => {
    const add = parseOpenedRecord({
      depotFile: '//depot/e.txt',
      clientFile: 'D:/work/e.txt',
      action: 'move/add',
    })
    expect(add?.action).toBe('move/add')
  })

  // Repro for "edited file shows as delete + `//` URI error": real `p4 opened`
  // reports `clientFile` in client syntax (`//clientName/rel`), not a local path.
  // With a clientRoot it must be translated to the on-disk path.
  it('translates a client-syntax clientFile onto the client root', () => {
    const file = parseOpenedRecord(
      {
        depotFile: '//depot/Src/Component/ElementalComponent.ts',
        clientFile: '//aki_ws/Src/Component/ElementalComponent.ts',
        change: 'default',
        action: 'edit',
        rev: '5',
      },
      'G:/aki_3.6',
    )
    expect(file?.clientFile).toBe('G:/aki_3.6/Src/Component/ElementalComponent.ts')
  })

  it('keeps clientFile verbatim when no clientRoot is given', () => {
    const file = parseOpenedRecord({
      depotFile: '//depot/a.txt',
      clientFile: '//aki_ws/a.txt',
      action: 'edit',
    })
    expect(file?.clientFile).toBe('//aki_ws/a.txt')
  })
})

describe('parseOpened / parsePending', () => {
  it('filters out non-file records', () => {
    const files = parseOpened([
      { depotFile: '//depot/a.txt', clientFile: 'D:/work/a.txt', action: 'edit' },
      { info: 'banner' },
    ])
    expect(files).toHaveLength(1)
  })

  it('parses pending changelist metadata', () => {
    const pending = parsePending([
      { change: '100', desc: 'first line\nsecond' },
      { change: '101' },
      { notAChange: true },
    ])
    expect(pending).toEqual([
      { id: '100', description: 'first line\nsecond' },
      { id: '101', description: '' },
    ])
  })
})
