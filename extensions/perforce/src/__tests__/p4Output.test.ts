import { describe, expect, it } from 'vitest'
import { parseMarshalJson, parseZtag, collapseNumberedKeys } from '../p4Output.js'

describe('parseMarshalJson', () => {
  it('parses one JSON object per line, skipping non-JSON banners', () => {
    const stdout = [
      '{"depotFile":"//depot/a.txt","action":"edit"}',
      'Perforce client info banner',
      '{"depotFile":"//depot/b.txt","action":"add"}',
      '',
    ].join('\n')
    const records = parseMarshalJson(stdout)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ depotFile: '//depot/a.txt', action: 'edit' })
    expect(records[1]).toMatchObject({ depotFile: '//depot/b.txt', action: 'add' })
  })

  it('returns empty for empty output', () => {
    expect(parseMarshalJson('')).toEqual([])
  })
})

describe('parseZtag', () => {
  it('parses tagged records separated by blank lines', () => {
    const stdout = [
      '... clientName my-ws',
      '... clientRoot D:/work',
      '',
      '... clientName other',
      '... clientRoot D:/other',
      '',
    ].join('\n')
    const records = parseZtag(stdout)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ clientName: 'my-ws', clientRoot: 'D:/work' })
    expect(records[1]).toMatchObject({ clientName: 'other', clientRoot: 'D:/other' })
  })

  it('handles a value containing spaces', () => {
    const records = parseZtag('... desc a multi word description\n\n')
    expect(records[0]).toMatchObject({ desc: 'a multi word description' })
  })

  it('collapses parallel numbered keys into an ordered array', () => {
    const stdout = [
      '... change 123',
      '... depotFile0 //depot/a.txt',
      '... depotFile1 //depot/b.txt',
      '... depotFile2 //depot/c.txt',
      '',
    ].join('\n')
    const record = parseZtag(stdout)[0]!
    expect(record['change']).toBe('123')
    expect(record['depotFile']).toEqual(['//depot/a.txt', '//depot/b.txt', '//depot/c.txt'])
  })
})

describe('collapseNumberedKeys', () => {
  it('keeps scalars and orders numbered keys numerically (10 after 2)', () => {
    const fields = new Map([
      ['name', 'x'],
      ['file0', 'a'],
      ['file2', 'c'],
      ['file10', 'k'],
      ['file1', 'b'],
    ])
    const out = collapseNumberedKeys(fields)
    expect(out['name']).toBe('x')
    expect(out['file']).toEqual(['a', 'b', 'c', 'k'])
  })
})
