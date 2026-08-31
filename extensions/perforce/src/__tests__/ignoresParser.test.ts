import { describe, expect, it } from 'vitest'
import { parseIgnores } from '../ignoresParser.js'

describe('parseIgnores', () => {
  it('returns the requested strings for lines with the ` ignored` suffix', () => {
    const requested = ['C:/ws/builds/a.txt', 'C:/ws/builds/b.txt']
    expect(parseIgnores('C:/ws/builds/a.txt ignored\n', requested)).toEqual(['C:/ws/builds/a.txt'])
  })

  it('returns the requested strings for lines without the ` ignored` suffix', () => {
    const requested = ['C:/ws/builds/a.txt']
    expect(parseIgnores('C:/ws/builds/a.txt\n', requested)).toEqual(['C:/ws/builds/a.txt'])
  })

  it('reverse-resolves paths containing spaces', () => {
    const requested = ['C:/ws/My Build/out file.txt']
    expect(parseIgnores('C:/ws/My Build/out file.txt ignored\n', requested)).toEqual([
      'C:/ws/My Build/out file.txt',
    ])
  })

  it('reverse-resolves Chinese paths', () => {
    const requested = ['C:/ws/构建/输出.txt']
    expect(parseIgnores('C:/ws/构建/输出.txt ignored\n', requested)).toEqual([
      'C:/ws/构建/输出.txt',
    ])
  })

  it('handles a filename that itself ends in ` ignored`', () => {
    // p4 appends its own ` ignored` to a name that already has it.
    const requested = ['X:/ws/foo ignored']
    expect(parseIgnores('X:/ws/foo ignored ignored\n', requested)).toEqual(['X:/ws/foo ignored'])
  })

  it('reverse-resolves a differently-cased, backslashed echo', () => {
    // norm folds separators and the drive letter on every platform; the rest of
    // the path folds only on a case-insensitive host (scopeKey).
    const requested = ['C:/Workspace/Builds/file.txt']
    const echo = 'c:\\workspace\\builds\\file.txt ignored'
    const insensitive = process.platform === 'win32' || process.platform === 'darwin'
    expect(parseIgnores(echo + '\n', requested)).toEqual(insensitive ? [requested[0]] : [])
  })

  it('drops unrelated noise lines', () => {
    const requested = ['C:/ws/a.txt']
    const stdout = [
      'C:/ws/a.txt ignored',
      'note: this is a hint line',
      '',
      'C:/ws/not-requested.txt ignored',
    ].join('\n')
    expect(parseIgnores(stdout, requested)).toEqual(['C:/ws/a.txt'])
  })

  it('drops indented continuation lines instead of reading them as paths', () => {
    const requested = ['C:/ws/a.txt']
    const stdout = ['C:/ws/a.txt ignored', '  an annotation block', '    continued'].join('\n')
    expect(parseIgnores(stdout, requested)).toEqual(['C:/ws/a.txt'])
  })

  it('returns values verbatim equal to the input strings', () => {
    const requested = ['C:/ws/a.txt', 'C:/ws/b.txt']
    const out = parseIgnores('C:/ws/a.txt ignored\nC:/ws/b.txt ignored\n', requested)
    expect(out[0]).toBe(requested[0])
    expect(out[1]).toBe(requested[1])
  })

  it('de-duplicates a path reported twice', () => {
    const requested = ['C:/ws/a.txt']
    expect(parseIgnores('C:/ws/a.txt ignored\nC:/ws/a.txt ignored\n', requested)).toEqual([
      'C:/ws/a.txt',
    ])
  })

  it('handles empty input and empty output', () => {
    expect(parseIgnores('', [])).toEqual([])
    expect(parseIgnores('', ['C:/ws/a.txt'])).toEqual([])
    expect(parseIgnores('C:/ws/a.txt ignored\n', [])).toEqual([])
  })
})
