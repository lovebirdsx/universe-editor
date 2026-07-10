import { describe, expect, it } from 'vitest'
import {
  parseMarshalJson,
  parseZtag,
  parseZtagAsMarshal,
  collapseNumberedKeys,
} from '../p4Output.js'
import { isCollapsed } from '../p4Service.js'

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

describe('isCollapsed', () => {
  it('detects -Mj output that collapsed into data blobs', () => {
    // Real shape from `p4 -Mj changes -s submitted -l` on a server that
    // degrades report-style commands to a per-line data blob.
    const records = parseMarshalJson(
      [
        '{"data":"Change 8080456 on 2026/07/11 by jenkins.aki@host \'msg\'\\n","level":0}',
        '{"data":"Change 8080454 on 2026/07/11 by jenkins.aki@host2 \'msg2\'\\n","level":0}',
      ].join('\n'),
    )
    expect(isCollapsed(records)).toBe(true)
  })

  it('is false for genuine structured records', () => {
    const records = parseMarshalJson('{"change":"8080456","user":"alice","time":"1700000000"}')
    expect(isCollapsed(records)).toBe(false)
  })

  it('is false for empty output (nothing to reshape)', () => {
    expect(isCollapsed([])).toBe(false)
  })

  it('is false when only some records carry data (mixed banner + record)', () => {
    const records = parseMarshalJson(
      ['{"data":"banner"}', '{"change":"7","user":"bob"}'].join('\n'),
    )
    expect(isCollapsed(records)).toBe(false)
  })
})

describe('parseZtagAsMarshal', () => {
  it('reshapes ztag changes into flat -Mj-compatible records', () => {
    // Real `p4 -ztag changes -s submitted -l` shape: records separated by blank
    // lines, `desc` may be the last field. Reshaped records must be readable by
    // the -Mj parser (parseChangesList) with `change`/`user`/`time`/`desc`.
    const stdout = [
      '... change 8080456',
      '... time 1783699976',
      '... user jenkins.aki',
      '... client host-a',
      '... status submitted',
      '... desc store build params',
      '',
      '',
      '... change 8080454',
      '... time 1783699875',
      '... user huyunjun',
      '... client host-b',
      '... status submitted',
      '... desc energy bar',
      '',
      '',
    ].join('\n')
    const records = parseZtagAsMarshal(stdout)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      change: '8080456',
      time: '1783699976',
      user: 'jenkins.aki',
      desc: 'store build params',
    })
    expect(records[1]).toMatchObject({ change: '8080454', user: 'huyunjun', desc: 'energy bar' })
  })

  it('keeps a multi-line desc intact and starts a new record on the repeated first key', () => {
    // `changes -l` desc can wrap across lines (continuation lines have no `... `
    // prefix); the blank line before the next `... change` must not truncate it.
    const stdout = [
      '... change 8080454',
      '... user jenkins.aki',
      '... desc line one',
      '\tline two indented',
      'line three',
      '',
      '... change 8080453',
      '... user bob',
      '... desc single',
      '',
    ].join('\n')
    const records = parseZtagAsMarshal(stdout)
    expect(records).toHaveLength(2)
    expect(records[0]!['desc']).toBe('line one\n\tline two indented\nline three')
    expect(records[1]).toMatchObject({ change: '8080453', desc: 'single' })
  })

  it('keeps numbered parallel keys flat (depotFile0/1) for describe', () => {
    // `p4 -ztag describe -s <n>`: a blank line sits *inside* the record between a
    // multi-line desc and the file list. Numbered keys must stay flat so
    // parseChangeDescribe's numberedValues() reads them.
    const stdout = [
      '... change 8080454',
      '... user alice',
      '... time 1783699875',
      '... desc fix widget',
      '\tmore detail',
      '',
      '... status submitted',
      '... depotFile0 //depot/a.js',
      '... action0 edit',
      '... rev0 9',
      '... depotFile1 //depot/b.js',
      '... action1 add',
      '... rev1 1',
      '',
    ].join('\n')
    const records = parseZtagAsMarshal(stdout)
    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r['change']).toBe('8080454')
    expect(r['desc']).toBe('fix widget\n\tmore detail')
    expect(r['depotFile0']).toBe('//depot/a.js')
    expect(r['action0']).toBe('edit')
    expect(r['rev0']).toBe('9')
    expect(r['depotFile1']).toBe('//depot/b.js')
    expect(r['action1']).toBe('add')
  })

  it('splits where output into one record per depotFile', () => {
    const stdout = [
      '... depotFile //depot/a.js',
      '... clientFile //ws/a.js',
      '... path C:\\ws\\a.js',
      '',
      '... depotFile //depot/b.js',
      '... clientFile //ws/b.js',
      '... path C:\\ws\\b.js',
      '',
    ].join('\n')
    const records = parseZtagAsMarshal(stdout)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ depotFile: '//depot/a.js', path: 'C:\\ws\\a.js' })
    expect(records[1]).toMatchObject({ depotFile: '//depot/b.js', path: 'C:\\ws\\b.js' })
  })

  it('returns empty for empty output', () => {
    expect(parseZtagAsMarshal('')).toEqual([])
  })
})
