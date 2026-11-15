import { describe, expect, it } from 'vitest'
import { isSafeRelativePath, parseVerdict } from '../verdict.js'

describe('parseVerdict', () => {
  it('parses both verdict kinds with an optional report path', () => {
    expect(parseVerdict(JSON.stringify({ verdict: 'info' }))).toEqual({
      ok: true,
      verdict: { verdict: 'info', summary: '' },
    })
    expect(
      parseVerdict(
        JSON.stringify({ verdict: 'escalate', summary: '需要人看', reportPath: 'report.md' }),
      ),
    ).toEqual({
      ok: true,
      verdict: { verdict: 'escalate', summary: '需要人看', reportPath: 'report.md' },
    })
  })

  it('defaults summary to an empty string and truncates long ones', () => {
    const missing = parseVerdict('{"verdict":"info"}')
    expect(missing.ok && missing.verdict.summary).toBe('')
    const long = parseVerdict(JSON.stringify({ verdict: 'info', summary: 'y'.repeat(250) }))
    expect(long.ok && long.verdict.summary).toHaveLength(200)
  })

  it('rejects malformed files and unknown verdicts', () => {
    for (const raw of ['', '   ', 'not json', '[]', '"x"']) {
      expect(parseVerdict(raw).ok, raw).toBe(false)
    }
    for (const kind of ['maybe', 'auto-approve', 'reject']) {
      expect(parseVerdict(JSON.stringify({ verdict: kind })).ok, kind).toBe(false)
    }
    expect(parseVerdict('{"verdict":"info"}').ok).toBe(true)
    expect(parseVerdict(JSON.stringify({ verdict: 'info', summary: 1 })).ok).toBe(false)
  })

  it('ignores a retired actions array instead of executing it', () => {
    expect(parseVerdict('{"verdict":"info","actions":[{"type":"swarm.vote"}]}')).toEqual({
      ok: true,
      verdict: { verdict: 'info', summary: '' },
    })
  })

  it('only accepts relative report paths without ".."', () => {
    expect(isSafeRelativePath('report.md')).toBe(true)
    expect(isSafeRelativePath('reports\\sub\\a.md')).toBe(true)
    expect(isSafeRelativePath('my report.md')).toBe(true)
    expect(isSafeRelativePath('./report.md')).toBe(true)
    for (const path of [
      '/abs.md',
      'C:/abs.md',
      '\\\\server\\x',
      '../a.md',
      'a/../../b.md',
      '',
      // Windows silently strips trailing dots/spaces and treats `:` as ADS/drive.
      'report.md.',
      'a/b.md. ',
      'trailing /b.md',
      'stream:name',
      'a\\.. /b.md',
    ]) {
      expect(isSafeRelativePath(path), path).toBe(false)
    }
    expect(parseVerdict(JSON.stringify({ verdict: 'info', reportPath: '../a.md' })).ok).toBe(false)
    expect(parseVerdict(JSON.stringify({ verdict: 'info', reportPath: 'a:b.md' })).ok).toBe(false)
  })
})
